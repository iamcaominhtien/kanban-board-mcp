//! Part of `services/notifications.py`: lines 1105 to 1557, "Resolving: a Needs you row closes itself", with the
//! reconcile that finds the rows to close.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use kb_db::Session;
use kb_db::entities::{
    ai_account, ai_project_settings, ai_run, ai_team, canvas_thread, docs_comment, docs_comment_thread, notification,
    notify_event, ticket,
};
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::db::save_notification;
use crate::delivery::{announce, head_id};
use crate::error::Result;
use crate::helpers::{self, dumps, loads_map, local, now_iso, parse, person_key, plural, utcnow};
use crate::recipients::owners_and_admins;
use crate::writing::EmitFields;
use crate::writing::{emit, flush_pending};

/// Why a Needs you row closed: (reason with `{who}`, by, gone), or `None` while it still needs someone.
pub type Why = Option<(String, Option<String>, bool)>;

/// Mark rows done with why, and write one resolve event per target to the log.
pub async fn resolve_rows(
    session: &Session,
    rows: Vec<notification::Model>,
    reason: &str,
    by: Option<&str>,
    gone: bool,
) -> Result<Option<i32>> {
    if rows.is_empty() {
        return Ok(None);
    }
    let at = now_iso();
    type Target = (String, Option<String>, Option<String>, Option<String>, Option<String>);
    let mut order: Vec<Target> = Vec::new();
    let mut targets: HashMap<Target, Vec<String>> = HashMap::new();
    for r in &rows {
        let mut after = r.clone();
        after.done_at = Some(at.clone());
        after.done_reason = Some(reason.to_string());
        after.done_by = by.map(str::to_string);
        after.snoozed_until = None;
        if gone {
            let mut d = loads_map(Some(&r.data));
            d.insert("gone".into(), json!(true));
            after.data = dumps(&Value::Object(d));
        }
        save_notification(session, r, &after).await?;
        let key =
            (r.kind.clone(), r.target_kind.clone(), r.target_id.clone(), r.project_id.clone(), r.ticket_id.clone());
        if !targets.contains_key(&key) {
            order.push(key.clone());
        }
        targets.entry(key).or_default().push(r.recipient.clone());
    }
    let mut last = None;
    for key in order {
        let (kind, tk, tid, pid, ticket) = key.clone();
        let mut keys = targets.remove(&key).unwrap_or_default();
        keys.sort();
        keys.dedup();
        let mut ev = notify_event::new();
        ev.project_id = ActiveValue::Set(pid);
        ev.kind = ActiveValue::Set(kind);
        ev.op = ActiveValue::Set("resolve".into());
        ev.needs = ActiveValue::Set(true);
        ev.target_kind = ActiveValue::Set(tk);
        ev.target_id = ActiveValue::Set(tid);
        ev.ticket_id = ActiveValue::Set(ticket);
        ev.actor = ActiveValue::Set(by.map(str::to_string));
        ev.title = ActiveValue::Set(reason.to_string());
        ev.recipients = ActiveValue::Set(dumps(&json!(keys)));
        ev.data = ActiveValue::Set(dumps(&json!({"gone": gone})));
        last = Some(ev.insert(session).await?.id);
    }
    session.commit().await?;
    announce(last).await;
    Ok(last)
}

/// Close every open Needs you row that points at this thing (for every recipient).
pub async fn resolve_target(
    target_kind: &str,
    target_id: &str,
    reason: &str,
    by: Option<&str>,
    kinds: Option<&[&str]>,
) -> Result<i64> {
    let session = kb_db::session();
    let mut stmt = notification::Entity::find()
        .filter(notification::Column::TargetKind.eq(target_kind))
        .filter(notification::Column::TargetId.eq(target_id))
        .filter(notification::Column::Needs.eq(true))
        .filter(notification::Column::DoneAt.is_null());
    if let Some(kinds) = kinds.filter(|k| !k.is_empty()) {
        stmt = stmt.filter(notification::Column::Kind.is_in(kinds.iter().copied()));
    }
    let rows = stmt.all(&session).await?;
    let n = rows.len() as i64;
    resolve_rows(&session, rows, reason, by, false).await?;
    Ok(n)
}

/// How an answer reached the AI, for "answered in the ticket".
pub fn via(name: &str) -> Option<&'static str> {
    match name {
        "mcp" => Some(" over MCP"),
        "ticket" => Some(" in the ticket"),
        "ai_team" => Some(" in AI Team"),
        "notification" | "toast" => Some(" from the notification"),
        _ => None,
    }
}

async fn exists_ticket(session: &Session, id: &str) -> Result<bool> {
    Ok(ticket::Entity::find().filter(ticket::Column::Id.eq(id)).count(session).await? > 0)
}

/// Why an open Needs you row no longer needs anyone: (reason with `{who}`, by, gone), or `None` while it still does.
pub async fn why_closed(session: &Session, r: &notification::Model) -> Result<Why> {
    if let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
        if !exists_ticket(session, t).await? {
            return Ok(Some((format!("{t} was deleted, so this cannot be answered."), None, true)));
        }
    }
    if r.target_kind.as_deref() == Some("run") {
        if let Some(id) = r.target_id.as_deref().filter(|t| !t.is_empty()) {
            let run = ai_run::Entity::find_by_id(id).one(session).await?;
            let Some(run) = run else {
                return Ok(Some(("The run is gone.".into(), None, true)));
            };
            if r.kind == "question" {
                return Ok(why_question_closed(&run));
            }
        }
    }
    why_closed_by_kind(session, r).await
}

/// `why_closed` once the ticket and the run it points at are still there.
pub async fn why_closed_by_kind(session: &Session, r: &notification::Model) -> Result<Why> {
    let target_id = r.target_id.as_deref().filter(|t| !t.is_empty());
    let target_kind = r.target_kind.as_deref();
    if r.kind == "run_stuck" && target_kind == Some("run") {
        if let Some(id) = target_id {
            return why_trouble_closed(session, id).await;
        }
    }
    if ["run_failed", "run_stopped_memory", "board_fault"].contains(&r.kind.as_str())
        && r.ticket_id.as_deref().is_some_and(|t| !t.is_empty())
    {
        return why_retried(session, r).await;
    }
    if r.kind == "window_urgent" {
        if let Some(id) = target_id {
            return why_window_closed(session, id).await;
        }
    }
    if r.kind == "merge_conflict" || r.kind == "arbitration" {
        return why_flag_closed(session, r).await;
    }
    if target_kind == Some("account") {
        if let Some(id) = target_id {
            return why_account_closed(session, id).await;
        }
    }
    if target_kind == Some("thread") && target_id.is_some() {
        return why_thread_closed(session, r).await;
    }
    if target_kind == Some("canvas_thread") {
        if let Some(id) = target_id {
            let n = canvas_thread::Entity::find().filter(canvas_thread::Column::Id.eq(id)).count(session).await?;
            if n == 0 {
                return Ok(Some(("The comment thread is gone.".into(), None, true)));
            }
            return Ok(None);
        }
    }
    if r.kind == "budget" {
        return why_budget_closed(session, r).await;
    }
    if r.kind == "auto_trip" {
        return why_pause_closed(session, r).await;
    }
    Ok(None)
}

/// A question closes once the run is no longer waiting for input.
pub fn why_question_closed(run: &ai_run::Model) -> Why {
    if run.state == "needs_input" {
        return None;
    }
    let q = loads_map(run.question.as_deref());
    if q.get("answered_at").is_some_and(kb_base::pyjson::truthy) {
        let answered_via = helpers::as_str(q.get("answered_via")).unwrap_or("");
        let place = via(answered_via).unwrap_or(" in the ticket");
        let by = helpers::as_str(q.get("answered_by")).map(str::to_string);
        return Some((format!("{{who}} answered{place}"), by, false));
    }
    Some((format!("The run ended ({}).", run.state.replace('_', " ")), run.ended_by.clone(), false))
}

/// A run in trouble: the row closes once it moved again, someone chose to wait, or the run ended.
pub async fn why_trouble_closed(session: &Session, run_id: &str) -> Result<Why> {
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(session).await? else {
        return Ok(Some(("The run is gone.".into(), None, true)));
    };
    if run.state != "running" && run.state != "starting" {
        return Ok(Some((format!("The run ended ({}).", run.state.replace('_', " ")), run.ended_by.clone(), false)));
    }
    let diag = loads_map(run.diagnosis.as_deref());
    if diag.is_empty() || diag.get("cleared_at").is_some_and(kb_base::pyjson::truthy) {
        let why = diag
            .get("cleared_why")
            .filter(|v| kb_base::pyjson::truthy(v))
            .map(kb_base::pyjson::py_str)
            .unwrap_or_else(|| "It started moving again.".to_string());
        return Ok(Some((why, None, false)));
    }
    Ok(None)
}

/// Urgent work waiting for a usage window closes once the run started.
pub async fn why_window_closed(session: &Session, run_id: &str) -> Result<Why> {
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(session).await? else {
        return Ok(Some(("The run is gone.".into(), None, true)));
    };
    if run.state != "queued" {
        return Ok(Some(("The run started.".into(), None, false)));
    }
    Ok(None)
}

/// A merge conflict or an arbitration closes when the ticket no longer carries the flag (services/ai/flags).
pub async fn why_flag_closed(_session: &Session, _r: &notification::Model) -> Result<Why> {
    Ok(None)
}

/// Retry answers every failure of the ticket: a run started after the latest one closes the row.
pub async fn why_retried(session: &Session, r: &notification::Model) -> Result<Why> {
    let newer = ai_run::Entity::find()
        .filter(ai_run::Column::TicketId.eq(r.ticket_id.clone()))
        .filter(ai_run::Column::Mode.eq("work"))
        .filter(ai_run::Column::QueuedAt.gt(r.updated_at.clone()))
        .order_by_asc(ai_run::Column::QueuedAt)
        .one(session)
        .await?;
    Ok(newer.map(|n| (format!("{{who}} retried: run #{} started", n.number), Some(n.started_by.clone()), false)))
}

/// An account's notification closes when it is removed (gone) or signed in again.
pub async fn why_account_closed(session: &Session, account_id: &str) -> Result<Why> {
    let Some(acc) = ai_account::Entity::find_by_id(account_id).one(session).await? else {
        return Ok(Some(("The account was removed.".into(), None, true)));
    };
    // only a confirmed sign-in closes it: a CLI briefly off PATH (cli_missing) says nothing about the sign-in
    if acc.status != "signed_in" {
        return Ok(None);
    }
    Ok(Some(("The account signed in again".into(), None, false)))
}

/// A mention in a Docs thread closes when the thread is gone, or when the person replied.
pub async fn why_thread_closed(session: &Session, r: &notification::Model) -> Result<Why> {
    let thread_id = r.target_id.clone().unwrap_or_default();
    let thread = docs_comment_thread::Entity::find_by_id(thread_id.clone()).one(session).await?;
    if thread.is_none() {
        return Ok(Some(("The thread is gone.".into(), None, true)));
    }
    if r.recipient.starts_with("ai:") {
        return Ok(None);
    }
    let replies = docs_comment::Entity::find()
        .filter(docs_comment::Column::ThreadId.eq(thread_id))
        .filter(docs_comment::Column::CreatedAt.gt(r.created_at.clone()))
        .all(session)
        .await?;
    if replies.iter().any(|c| person_key(Some(&c.author)) == r.recipient) {
        return Ok(Some(("{who} replied".into(), Some(r.recipient.clone()), false)));
    }
    Ok(None)
}

/// A budget notification closes when the day rolled over.
pub async fn why_budget_closed(_session: &Session, r: &notification::Model) -> Result<Why> {
    let created = parse(Some(&r.created_at)).map(|d| local(&d)).unwrap_or_else(|| local(&utcnow()));
    if created.date_naive() != local(&utcnow()).date_naive() {
        return Ok(Some(("The day rolled over".into(), None, false)));
    }
    Ok(None)
}

/// Pause all AI of a project, or one AI team paused (auto-trip).
pub async fn why_pause_closed(session: &Session, r: &notification::Model) -> Result<Why> {
    let target_kind = r.target_kind.as_deref();
    if let Some(project_id) = r.project_id.as_deref().filter(|p| !p.is_empty()) {
        if target_kind.is_none() || target_kind == Some("project") {
            let s = ai_project_settings::Entity::find_by_id(project_id).one(session).await?;
            if let Some(s) = s {
                if !s.paused_all {
                    return Ok(Some(("AI was resumed".into(), None, false)));
                }
            }
            return Ok(None);
        }
    }
    if target_kind == Some("member") {
        if let Some(id) = r.target_id.as_deref().filter(|t| !t.is_empty()) {
            let Some(profile) = ai_team::Entity::find_by_id(id).one(session).await? else {
                return Ok(Some(("The AI team was removed.".into(), None, true)));
            };
            if !profile.paused {
                return Ok(Some(("The AI team was resumed".into(), None, false)));
            }
        }
    }
    Ok(None)
}

static RECONCILE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Close every open Needs you row whose thing no longer needs a person, and note AI accounts that signed out.
/// Cheap: it reads only open Needs you rows. One at a time (requests and the loop both call it), so an account is
/// noted and a row resolved once. Returns how many rows closed.
pub async fn reconcile() -> Result<i64> {
    let _held = RECONCILE_LOCK.lock().await;
    reconcile_inner().await
}

async fn reconcile_inner() -> Result<i64> {
    let mut closed = 0;
    flush_pending().await?;
    let session = kb_db::session();
    watch_accounts(&session).await?;
    let groups = open_needs_groups(&session).await?;
    // rows that only their target going away can close are checked together, in a few queries
    let firsts: Vec<notification::Model> =
        groups.iter().filter(|g| !closes_by_itself(&g[0])).map(|g| g[0].clone()).collect();
    let alive = alive_targets(&session, &firsts).await?;
    for same in groups {
        let why = if closes_by_itself(&same[0]) {
            why_closed(&session, &same[0]).await
        } else {
            Ok(why_gone(&same[0], &alive))
        };
        let why = match why {
            Ok(w) => w,
            Err(e) => {
                tracing::error!("Could not check notification {}: {e}", same[0].id);
                continue;
            }
        };
        let Some((reason, by, gone)) = why else { continue };
        if gone {
            // The row says so and offers only Dismiss; it is not closed quietly
            mark_gone(&session, &same, &reason).await?;
            continue;
        }
        let n = same.len() as i64;
        resolve_rows(&session, same, &reason, by.as_deref(), false).await?;
        closed += n;
    }
    Ok(closed)
}

/// A row whose target is gone says so once (`mark_gone`) and then waits for Dismiss: nothing closes it by itself.
pub const GONE: &str = "\"gone\": true";

/// The open Needs you rows, by what they point at (each group is judged once). Rows already marked gone are left
/// out: nothing but Dismiss closes them.
pub async fn open_needs_groups(session: &Session) -> Result<Vec<Vec<notification::Model>>> {
    let rows = notification::Entity::find()
        .filter(notification::Column::Needs.eq(true))
        .filter(notification::Column::DoneAt.is_null())
        .filter(notification::Column::Data.not_like(format!("%{GONE}%")))
        .all(session)
        .await?;
    type GroupKey = (String, Option<String>, Option<String>, Option<String>, Option<String>, String);
    let mut index: HashMap<GroupKey, usize> = HashMap::new();
    let mut groups: Vec<Vec<notification::Model>> = Vec::new();
    for r in rows {
        // a reply closes the mention of the person who replied, not everyone's: threads are judged per row
        let who = if r.target_kind.as_deref() == Some("thread") { r.recipient.clone() } else { String::new() };
        let key = (
            r.kind.clone(),
            r.target_kind.clone(),
            r.target_id.clone(),
            r.ticket_id.clone(),
            r.project_id.clone(),
            who,
        );
        match index.get(&key) {
            Some(i) => groups[*i].push(r),
            None => {
                index.insert(key, groups.len());
                groups.push(vec![r]);
            }
        }
    }
    Ok(groups)
}

/// Whether something other than its target going away can close a row. An offline row closes only by Dismiss, and a
/// mention of an AI member only when its thread goes (an AI does not reply in Docs).
pub fn closes_by_itself(r: &notification::Model) -> bool {
    if r.kind == "offline" {
        return matches!(r.target_kind.as_deref(), Some("account") | Some("thread"));
    }
    if r.kind == "mention" && r.target_kind.as_deref() == Some("thread") {
        return !r.recipient.starts_with("ai:");
    }
    true
}

/// Which of the tickets, runs and threads these rows point at still exist: one query per table, not per row.
pub async fn alive_targets(
    session: &Session,
    rows: &[notification::Model],
) -> Result<HashMap<&'static str, HashSet<String>>> {
    let mut wanted: HashMap<&'static str, std::collections::BTreeSet<String>> = HashMap::new();
    for name in ["ticket", "run", "thread"] {
        wanted.insert(name, Default::default());
    }
    for r in rows {
        if let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            wanted.entry("ticket").or_default().insert(t.to_string());
        }
        if let (Some(kind), Some(id)) = (r.target_kind.as_deref(), r.target_id.as_deref().filter(|t| !t.is_empty())) {
            if kind == "run" || kind == "thread" {
                wanted.entry(if kind == "run" { "run" } else { "thread" }).or_default().insert(id.to_string());
            }
        }
    }
    let mut alive: HashMap<&'static str, HashSet<String>> = HashMap::new();
    for (name, ids) in wanted {
        let chunk: Vec<String> = ids.into_iter().collect();
        let mut found: HashSet<String> = HashSet::new();
        for part in chunk.chunks(500) {
            let ids_found: Vec<String> = match name {
                "ticket" => {
                    ticket::Entity::find()
                        .select_only()
                        .column(ticket::Column::Id)
                        .filter(ticket::Column::Id.is_in(part.iter().cloned()))
                        .into_tuple::<String>()
                        .all(session)
                        .await?
                }
                "run" => {
                    ai_run::Entity::find()
                        .select_only()
                        .column(ai_run::Column::Id)
                        .filter(ai_run::Column::Id.is_in(part.iter().cloned()))
                        .into_tuple::<String>()
                        .all(session)
                        .await?
                }
                _ => {
                    docs_comment_thread::Entity::find()
                        .select_only()
                        .column(docs_comment_thread::Column::Id)
                        .filter(docs_comment_thread::Column::Id.is_in(part.iter().cloned()))
                        .into_tuple::<String>()
                        .all(session)
                        .await?
                }
            };
            found.extend(ids_found);
        }
        alive.insert(name, found);
    }
    Ok(alive)
}

/// `why_closed` of a row that does not close by itself: only its ticket, run or thread going away changes it.
pub fn why_gone(r: &notification::Model, alive: &HashMap<&'static str, HashSet<String>>) -> Why {
    let has = |name: &str, id: &str| alive.get(name).is_some_and(|s| s.contains(id));
    if let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
        if !has("ticket", t) {
            return Some((format!("{t} was deleted, so this cannot be answered."), None, true));
        }
    }
    if let Some(id) = r.target_id.as_deref().filter(|t| !t.is_empty()) {
        if r.target_kind.as_deref() == Some("run") && !has("run", id) {
            return Some(("The run is gone.".into(), None, true));
        }
        if r.target_kind.as_deref() == Some("thread") && !has("thread", id) {
            return Some(("The thread is gone.".into(), None, true));
        }
    }
    None
}

/// The thing a row points at is gone: the row says so (once) and offers only Dismiss.
pub async fn mark_gone(session: &Session, rows: &[notification::Model], reason: &str) -> Result<()> {
    let mut changed = false;
    for r in rows {
        let mut d = loads_map(Some(&r.data));
        if !d.get("gone").is_some_and(kb_base::pyjson::truthy) {
            d.insert("gone".into(), json!(true));
            d.insert("gone_reason".into(), json!(reason));
            let mut after = r.clone();
            after.data = dumps(&Value::Object(d));
            after.updated_at = now_iso();
            save_notification(session, r, &after).await?;
            changed = true;
        }
    }
    if changed {
        session.commit().await?;
        announce(Some(head_id(session).await?)).await;
    }
    Ok(())
}

/// One Needs you notification per AI account that was found signed out (not per member on it).
pub async fn watch_accounts(session: &Session) -> Result<()> {
    let rows = ai_account::Entity::find()
        .filter(ai_account::Column::Status.eq("needs_sign_in"))
        .filter(ai_account::Column::SignedOutAt.is_not_null())
        .all(session)
        .await?;
    for acc in rows {
        if sign_out_noted(session, &acc).await? {
            continue;
        }
        let on = ai_team::Entity::find().filter(ai_team::Column::AccountId.eq(acc.id.clone())).all(session).await?;
        let mut projects: Vec<String> = on.iter().map(|p| p.project_id.clone()).collect();
        projects.sort();
        projects.dedup();
        let n = on.len() as i64;
        let mut body = "No AI team uses it right now.".to_string();
        if n > 0 {
            body = format!("{n} AI team{} on this account stopped. Their queued runs are held.", plural(n));
        }
        emit(
            "account_signed_out",
            Some(session),
            EmitFields {
                project_id: if projects.len() == 1 { Some(projects[0].clone()) } else { None },
                recipients: user_and_admins_of(session, &projects).await?,
                title: format!("{} is signed out", acc.name),
                body: Some(body),
                target_kind: Some("account".into()),
                target_id: Some(acc.id.clone()),
                data: Some(match json!({"members": n, "how": acc.signed_out_how}) {
                    Value::Object(m) => m,
                    _ => Default::default(),
                }),
                ..Default::default()
            },
        )
        .await?;
    }
    Ok(())
}

/// Whether this sign-out of the account was already told.
pub async fn sign_out_noted(session: &Session, acc: &ai_account::Model) -> Result<bool> {
    let seen = notify_event::Entity::find()
        .filter(notify_event::Column::Kind.eq("account_signed_out"))
        .filter(notify_event::Column::TargetId.eq(acc.id.clone()))
        .filter(notify_event::Column::Op.eq("new"))
        .filter(notify_event::Column::CreatedAt.gte(acc.signed_out_at.clone().unwrap_or_default()))
        .one(session)
        .await?;
    Ok(seen.is_some())
}

/// The board's own user, then the owners and admins of these projects, each once.
pub async fn user_and_admins_of(session: &Session, project_ids: &[String]) -> Result<Vec<String>> {
    let mut recipients = vec!["user".to_string()];
    for pid in project_ids {
        for k in owners_and_admins(session, Some(pid)).await? {
            if !recipients.contains(&k) {
                recipients.push(k);
            }
        }
    }
    Ok(recipients)
}
