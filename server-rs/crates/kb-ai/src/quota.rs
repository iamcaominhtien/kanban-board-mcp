//! The usage window of a Claude account (design/screens/ai-operations.md, E).
//!
//! On a subscription what runs out is the window of an account, not money. Claude Code reports it in every run's stream:
//! `{"type": "rate_limit_event", "rate_limit_info": {"status", "resetsAt", "rateLimitType", "unifiedWindows":
//! {"five_hour": {"utilization": 0..1, "resetsAt", "status"}, "seven_day": {...}}}}` (spike S5). The board keeps the last
//! reading per account and, when a window is used up, holds every run of that account until it reopens. A hold is not a
//! failure and is never counted as a try.
//!
//! An account here is an `AiAccount` id, or `"local"` for Claude Code members that run on the person's own CLI
//! login (`"local:<provider>"` for another CLI's own login, so its runs never count on Claude's). Windows and slots
//! are Claude's: only Claude Code runs wait on them.
//!
//! Concurrency: at most `max_parallel` CLI runs per account at once (2 by default, set per account).

use std::collections::HashMap;

use chrono::{DateTime, Local, TimeZone, Utc};
use kb_base::{pyjson, time};
use kb_db::Session;
use kb_db::database;
use kb_db::save_model;
use kb_db::entities::{ai_account, ai_account_state, ai_run, ai_team};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use crate::store::py_int;

/// The account key of this computer's own Claude Code login.
pub const LOCAL: &str = "local";
/// How many CLI runs an account runs at once unless set.
pub const DEFAULT_PARALLEL: i32 = 2;
/// "quota near" signal and the bar's amber.
pub const NEAR: f64 = 0.8;

/// Which account a run spends: the run's own override (urgent work moved), else the member's account, else this
/// computer's own Claude Code login.
pub fn key_for(profile: Option<&ai_team::Model>, run: Option<&ai_run::Model>) -> String {
    if let Some(account) = run.and_then(|r| r.account_id.as_deref()).filter(|a| !a.is_empty()) {
        return account.to_string();
    }
    if let Some(account) = profile.and_then(|p| p.account_id.as_deref()).filter(|a| !a.is_empty()) {
        return account.to_string();
    }
    LOCAL.to_string()
}

/// `datetime.fromtimestamp(int(epoch), UTC).isoformat()`, or None where Python raises.
fn iso_of(epoch: Option<&Value>) -> Option<String> {
    let seconds = i64::try_from(py_int(epoch?)?).ok()?;
    let dt = Utc.timestamp_opt(seconds, 0).single()?;
    // Python's datetime stops at the year 9999 and starts at 1
    if !(1..=9999).contains(&chrono::Datelike::year(&dt)) {
        return None;
    }
    Some(time::iso(&dt))
}

/// The account's row, created on first use.
pub async fn state(session: &Session, key: &str) -> Result<ai_account_state::Model, DbErr> {
    if let Some(row) = ai_account_state::Entity::find_by_id(key).one(session).await? {
        return Ok(row);
    }
    let mut row = ai_account_state::new();
    row.key = kb_db::sea_orm::ActiveValue::Set(key.to_string());
    database::insert_missing(session, row).await?;
    ai_account_state::Entity::find_by_id(key)
        .one(session)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("ai_account_state {key}")))
}

/// A `rate_limit_event` to `{status, resets_at, type, five_hour: {used, resets_at, status}, seven_day: {...}}`.
pub fn parse_event(event: &Value) -> Option<Map<String, Value>> {
    let event = event.as_object()?;
    if event.get("type") != Some(&json!("rate_limit_event")) {
        return None;
    }
    let empty = Map::new();
    let info = match event.get("rate_limit_info") {
        Some(Value::Object(info)) => info,
        _ => &empty,
    };
    let mut out = Map::new();
    out.insert("status".into(), info.get("status").cloned().unwrap_or(Value::Null));
    out.insert("resets_at".into(), json!(iso_of(info.get("resetsAt"))));
    out.insert("type".into(), info.get("rateLimitType").cloned().unwrap_or(Value::Null));
    if let Some(Value::Object(windows)) = info.get("unifiedWindows") {
        for (name, window) in windows {
            if let Value::Object(window) = window {
                let mut w = Map::new();
                w.insert("used".into(), window.get("utilization").cloned().unwrap_or(Value::Null));
                w.insert("resets_at".into(), json!(iso_of(window.get("resetsAt"))));
                w.insert("status".into(), window.get("status").cloned().unwrap_or(Value::Null));
                out.insert(name.clone(), Value::Object(w));
            }
        }
    }
    Some(out)
}

fn as_float(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

fn text_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        // a status that is not text is stored as Python's `str` of it would be shown
        Some(other) => Some(pyjson::py_str(other)),
    }
}

/// Keep the latest reading of an account; a rejected window holds the account until it reopens.
pub async fn record(key: &str, reading: &Map<String, Value>) -> Result<ai_account_state::Model, DbErr> {
    let session = database::session();
    let read = state(&session, key).await?;
    let mut row = read.clone();
    for name in ["five_hour", "seven_day"] {
        let Some(w) = reading.get(name).filter(|w| pyjson::truthy(w)) else { continue };
        let used = w.get("used").and_then(as_float);
        let (resets_at, status) = (text_of(w.get("resets_at")), text_of(w.get("status")));
        if name == "five_hour" {
            if let Some(used) = used {
                row.five_hour_used = Some(used);
            }
            row.five_hour_resets_at = resets_at;
            row.five_hour_status = status;
        } else {
            if let Some(used) = used {
                row.seven_day_used = Some(used);
            }
            row.seven_day_resets_at = resets_at;
            row.seven_day_status = status;
        }
    }
    if reading.get("status") == Some(&json!("rejected")) {
        if let Some(until) = reading.get("resets_at").and_then(Value::as_str).filter(|u| !u.is_empty()) {
            hold(&mut row, until, reading.get("type").and_then(Value::as_str));
        }
    }
    row.updated_at = Some(time::now_iso());
    let row = save_model(&session, &read, row).await?;
    session.commit().await?;
    Ok(row)
}

/// Hold every run of the account until `until` (the reset the CLI reported).
pub fn hold(row: &mut ai_account_state::Model, until: &str, window: Option<&str>) {
    if row.held_until.as_deref().is_none_or(|current| current < until) {
        row.held_until = Some(until.to_string());
    }
    let label = match window.unwrap_or("") {
        "five_hour" => "5-hour",
        "seven_day" => "weekly",
        _ => "usage",
    };
    row.held_reason = Some(format!("The {label} window is used up"));
}

/// Hold an account from outside a reading (a result that says the limit was hit).
pub async fn hold_until(key: &str, until: &str, window: Option<&str>) -> Result<(), DbErr> {
    let session = database::session();
    let read = state(&session, key).await?;
    let mut row = read.clone();
    hold(&mut row, until, window);
    row.updated_at = Some(time::now_iso());
    save_model(&session, &read, row).await?;
    session.commit().await
}

/// The reset time while the account is held, else None.
pub fn held(row: Option<&ai_account_state::Model>, now: Option<DateTime<Utc>>) -> Option<String> {
    let row = row?;
    let held_until = row.held_until.as_deref().filter(|h| !h.is_empty())?;
    let until = crate::store::parse_iso(Some(held_until))?;
    (until.with_timezone(&Utc) > now.unwrap_or_else(Utc::now)).then(|| held_until.to_string())
}

/// Accounts whose window reopened: clear the hold (their runs start in the same tick).
pub async fn release_expired(session: &Session) -> Result<Vec<String>, DbErr> {
    let rows =
        ai_account_state::Entity::find().filter(ai_account_state::Column::HeldUntil.is_not_null()).all(session).await?;
    let mut out = Vec::new();
    for read in rows {
        if held(Some(&read), None).is_none() {
            let mut row = read.clone();
            row.held_until = None;
            row.held_reason = None;
            out.push(row.key.clone());
            save_model(session, &read, row).await?;
        }
    }
    if !out.is_empty() {
        session.commit().await?;
    }
    Ok(out)
}

/// CLI runs going on an account right now.
pub async fn running_on(session: &Session, key: &str) -> Result<Vec<ai_run::Model>, DbErr> {
    let runs = ai_run::Entity::find().filter(ai_run::Column::State.is_in(["starting", "running"])).all(session).await?;
    if runs.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = runs.iter().map(|r| r.member_id.clone()).collect();
    let teams: HashMap<String, ai_team::Model> = ai_team::Entity::find()
        .filter(ai_team::Column::Id.is_in(ids))
        .filter(ai_team::Column::Connection.ne("api_key"))
        .all(session)
        .await?
        .into_iter()
        .map(|t| (t.id.clone(), t))
        .collect();
    Ok(runs
        .into_iter()
        .filter(|run| teams.get(&run.member_id).is_some_and(|p| key_for(Some(p), Some(run)) == key))
        .collect())
}

/// `%H:%M` of a stored time in the zone `tz`, "" when it is empty or not a time. A time without an offset is a wall
/// time of that zone (`datetime.astimezone()` reads a naive time as local).
pub fn local_in<Z: TimeZone>(when: Option<&str>, tz: &Z) -> String
where
    Z::Offset: std::fmt::Display,
{
    let Some((naive, offset)) = when.filter(|w| !w.is_empty()).and_then(crate::store::isoformat_parts) else {
        return String::new();
    };
    let instant = match offset {
        Some(seconds) => (naive - chrono::Duration::seconds(i64::from(seconds))).and_utc(),
        None => crate::budget::local_naive_to_utc(tz, naive),
    };
    instant.with_timezone(tz).format("%H:%M").to_string()
}

fn limit_of(row: &ai_account_state::Model) -> i64 {
    let n = if row.max_parallel != 0 { row.max_parallel } else { DEFAULT_PARALLEL };
    i64::from(n).max(1)
}

/// Why a queued CLI run waits on its account (the window or the slots), or None.
pub async fn blocking(
    session: &Session,
    run: &ai_run::Model,
    profile: &ai_team::Model,
) -> Result<Option<String>, DbErr> {
    if profile.connection == "api_key" || profile.provider != "claude-code" {
        // windows and slots are Claude's (the accounts page shows only those): another CLI is not held by them
        return Ok(None);
    }
    let key = key_for(Some(profile), Some(run));
    // A check only reads: an account without a row yet is not held and has the default slots. Creating the row here
    // made every scheduler tick a write (taking SQLite's write lock) for nothing
    let row = match ai_account_state::Entity::find_by_id(key.as_str()).one(session).await? {
        Some(row) => row,
        None => default_state(&key),
    };
    if let Some(until) = held(Some(&row), None) {
        let reason = row.held_reason.as_deref().filter(|r| !r.is_empty()).unwrap_or("the usage window is used up");
        return Ok(Some(format!("Waiting for the next window: {reason}, reopens {}", local_in(Some(&until), &Local))));
    }
    let going: Vec<_> = running_on(session, &key).await?.into_iter().filter(|r| r.id != run.id).collect();
    let limit = limit_of(&row);
    if going.len() as i64 >= limit {
        return Ok(Some(format!("Waiting for a free slot on the account ({} of {limit} in use)", going.len())));
    }
    Ok(None)
}

/// `AiAccountState(key=key)`: a row that is not stored, with the defaults of the model.
pub fn default_state(key: &str) -> ai_account_state::Model {
    ai_account_state::Model {
        key: key.to_string(),
        max_parallel: DEFAULT_PARALLEL,
        move_urgent: false,
        five_hour_used: None,
        five_hour_resets_at: None,
        five_hour_status: None,
        seven_day_used: None,
        seven_day_resets_at: None,
        seven_day_status: None,
        held_until: None,
        held_reason: None,
        updated_at: None,
    }
}

/// Claude accounts that could take one more run now: signed in, not held, a slot free. Best first.
pub async fn room(session: &Session, exclude: Option<&str>) -> Result<Vec<Value>, DbErr> {
    let accounts = ai_account::Entity::find()
        .filter(ai_account::Column::Cli.eq("claude"))
        .filter(ai_account::Column::Status.eq("signed_in"))
        .all(session)
        .await?;
    let mut out: Vec<(Option<f64>, Value)> = Vec::new();
    for acct in accounts {
        if exclude == Some(acct.id.as_str()) {
            continue;
        }
        let row = state(session, &acct.id).await?;
        if held(Some(&row), None).is_some() {
            continue;
        }
        let going = running_on(session, &acct.id).await?.len() as i64;
        let limit = limit_of(&row);
        if going >= limit {
            continue;
        }
        let entry = json!({
            "account_id": acct.id,
            "name": acct.name,
            "email": acct.email,
            "plan": acct.plan,
            "used": row.five_hour_used,
            "free": limit - going,
        });
        out.push((row.five_hour_used, entry));
    }
    out.sort_by(|a, b| a.0.unwrap_or(0.5).total_cmp(&b.0.unwrap_or(0.5)));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

/// Every account's window for the accounts page: used, reset, held, slots, what waits on it.
pub async fn overview(session: &Session) -> Result<Vec<Value>, DbErr> {
    let accounts = ai_account::Entity::find().filter(ai_account::Column::Cli.eq("claude")).all(session).await?;
    let mut keys: Vec<(String, Option<ai_account::Model>)> =
        accounts.into_iter().map(|a| (a.id.clone(), Some(a))).collect();
    let has_local = ai_team::Entity::find()
        .filter(ai_team::Column::AccountId.is_null())
        .filter(ai_team::Column::Provider.eq("claude-code"))
        .filter(ai_team::Column::Connection.ne("api_key"))
        .one(session)
        .await?;
    if has_local.is_some() {
        keys.push((LOCAL.to_string(), None));
    }
    let queued_runs = ai_run::Entity::find().filter(ai_run::Column::State.eq("queued")).all(session).await?;
    let team_ids: Vec<String> = queued_runs.iter().map(|r| r.member_id.clone()).collect();
    let teams: HashMap<String, ai_team::Model> = if team_ids.is_empty() {
        HashMap::new()
    } else {
        ai_team::Entity::find()
            .filter(ai_team::Column::Id.is_in(team_ids))
            .all(session)
            .await?
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect()
    };
    let mut out = Vec::new();
    for (key, acct) in keys {
        let row = state(session, &key).await?;
        let going = running_on(session, &key).await?;
        let waiting = queued_runs
            .iter()
            .filter(|r| teams.get(&r.member_id).is_some_and(|p| key_for(Some(p), Some(r)) == key))
            .count();
        let held_now = held(Some(&row), None);
        let max_parallel = if row.max_parallel != 0 { row.max_parallel } else { DEFAULT_PARALLEL };
        out.push(json!({
            "key": key,
            "name": acct.as_ref().map_or("This computer's own Claude login".to_string(), |a| a.name.clone()),
            "email": acct.as_ref().and_then(|a| a.email.clone()),
            "plan": acct.as_ref().and_then(|a| a.plan.clone()),
            "status": acct.as_ref().map_or("signed_in".to_string(), |a| a.status.clone()),
            "max_parallel": max_parallel,
            "running": going.iter().map(|r| json!({
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "member_id": r.member_id,
                "started_at": r.started_at,
            })).collect::<Vec<_>>(),
            "waiting": waiting,
            "five_hour": {
                "used": row.five_hour_used,
                "resets_at": row.five_hour_resets_at,
                "status": row.five_hour_status,
            },
            "seven_day": {
                "used": row.seven_day_used,
                "resets_at": row.seven_day_resets_at,
                "status": row.seven_day_status,
            },
            "held_until": held_now,
            "held_reason": if held_now.is_some() { json!(row.held_reason) } else { Value::Null },
            "move_urgent": row.move_urgent,
            "read_at": row.updated_at,
        }));
    }
    session.commit().await?;
    Ok(out)
}

/// Change an account's limit or its "move urgent work by itself" switch.
pub async fn set_account(
    session: &Session,
    key: &str,
    max_parallel: Option<i64>,
    move_urgent: Option<bool>,
) -> Result<ai_account_state::Model, DbErr> {
    let read = state(session, key).await?;
    let mut row = read.clone();
    if let Some(max_parallel) = max_parallel {
        row.max_parallel = max_parallel.clamp(1, 20) as i32;
    }
    if let Some(move_urgent) = move_urgent {
        row.move_urgent = move_urgent;
    }
    row.updated_at = Some(time::now_iso());
    let row = save_model(session, &read, row).await?;
    session.commit().await?;
    Ok(row)
}
