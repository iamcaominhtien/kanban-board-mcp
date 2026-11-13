//! Part of `services/notifications.py`: lines 1979 to 2545, "Reading": a row for the API, the list with its views
//! and filters, the bell's counts, the feed since a log id and the raw log.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, Utc};
use kb_db::Session;
use kb_db::entities::{member, notification, notify_event};
use kb_db::sea_orm::sea_query::{BinOper, Expr, ExprTrait, Func, LikeExpr};
use kb_db::sea_orm::{
    ColumnTrait, Condition, EntityTrait, Order, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Value, json};

use crate::delivery::head_id;
use crate::error::{NotifyError, Result};
use crate::helpers::{as_str, dumps, iso, loads_list, loads_map, local, midnight, parse, person_key, truthy, utcnow};
use crate::kinds::{PANEL_DAYS, kind_info};
use crate::recipients::managed_projects;
use crate::settings::{get_prefs, global, in_quiet_hours, sound_name};

fn act(id: &str, label: &str) -> Value {
    json!({"id": id, "label": label})
}

/// The buttons a row offers.
pub fn actions(r: &notification::Model, gone: bool) -> Vec<Value> {
    if r.done_at.as_deref().is_some_and(|d| !d.is_empty()) {
        return Vec::new();
    }
    if gone {
        return vec![act("dismiss", "Dismiss")];
    }
    let k = r.kind.as_str();
    match k {
        "question" => return vec![act("answer", "Answer"), act("open_ticket", "Open ticket")],
        // a stopped run: Retry, or look at the run (Notifications board, C and D)
        "run_failed" | "run_stopped_memory" | "board_fault" => {
            return vec![act("retry", "Retry"), act("open_run_log", "Open run log")];
        }
        "run_stuck" => {
            let labels = [
                ("stop_child", "Stop that command, keep the run"),
                ("tell_ai", "Tell the AI to run it in the background"),
                ("wait", "Wait, tell me again at 30 min"),
                ("continue_note", "Continue with a note"),
                ("cancel", "Cancel the run"),
            ];
            let data = loads_map(Some(&r.data));
            let diag = data
                .get("diagnosis")
                .filter(|v| truthy(Some(v)))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let wanted: Vec<String> = match diag.get("actions").filter(|v| truthy(Some(v))) {
                Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
                Some(_) => Vec::new(),
                None => ["continue_note", "wait", "cancel"].iter().map(|s| s.to_string()).collect(),
            };
            let mut out: Vec<Value> = wanted
                .iter()
                .filter_map(|a| {
                    labels.iter().find(|(id, _)| id == a).map(|(id, label)| act(&format!("trouble:{id}"), label))
                })
                .collect();
            out.push(act("open_run_log", "Open the run"));
            return out;
        }
        "merge_conflict" => {
            return vec![
                act("conflict:ai", "Hand it to an AI"),
                act("conflict:me", "I will do it"),
                act("open_ticket", "Open ticket"),
            ];
        }
        "arbitration" => {
            return vec![
                act("arbitration:reviewer", "Side with Reviewer"),
                act("arbitration:dev", "Side with Dev"),
                act("arbitration:split", "Split the ticket"),
                act("open_ticket", "Read the arbitration"),
            ];
        }
        "workflow_step" => {
            return vec![
                act("workflow:approve", "Approve"),
                act("workflow:send_back", "Send back"),
                act("open_ticket", "Open ticket"),
            ];
        }
        "window_urgent" => return vec![act("move_account", "Move urgent work"), act("open_ai", "Open accounts")],
        "account_signed_out" => return vec![act("sign_in", "Sign in again")],
        "mention" => {
            if r.target_kind.as_deref() == Some("canvas_thread") {
                // a canvas comment is answered on the canvas, not from the row
                return vec![act("open", "Open")];
            }
            return vec![act("reply", "Reply"), act("open", "Open")];
        }
        "budget" | "auto_trip" | "offline" => return vec![act("open_ai", "Open AI Team")],
        "day_card" => return vec![act("open", "Open")],
        _ => {}
    }
    if k == "schedule_started" && r.count <= 1 {
        return vec![act("open_run_log", "Open run")];
    }
    if k == "schedule" && r.count <= 1 {
        let data = loads_map(Some(&r.data));
        if as_str(data.get("event")) == Some("skipped") && truthy(data.get("schedule_id")) {
            // design E4: a skipped slot offers to plan it again
            return vec![act("reschedule", "Reschedule"), act("open", "Open")];
        }
    }
    if r.count > 1 {
        return vec![act("expand", &format!("Show all {}", r.count))];
    }
    vec![act("open", "Open")]
}

/// What a closed row says about why: "Dismissed by you", "Hoa answered in the ticket".
pub fn done_text(r: &notification::Model, me: &str) -> Option<String> {
    if r.done_at.as_deref().is_none_or(str::is_empty) {
        return None;
    }
    let mut reason = r.done_reason.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "Done".to_string());
    if reason.contains("{who}") {
        let who = match r.done_by.as_deref().filter(|b| !b.is_empty()) {
            Some(by) if person_key(Some(by)) == me => "you".to_string(),
            Some(by) => by.to_string(),
            None => "someone".to_string(),
        };
        reason = reason.replace("{who}", &who);
    }
    let mut chars = reason.chars();
    Some(match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    })
}

/// A row for the API, as `me` sees it.
pub fn to_dict(r: &notification::Model, me: &str, names: Option<&HashMap<String, String>>) -> Value {
    let data = loads_map(Some(&r.data));
    let gone = data.get("gone").is_some_and(kb_base::pyjson::truthy);
    let now = utcnow();
    let snoozed = r
        .snoozed_until
        .as_deref()
        .filter(|s| !s.is_empty())
        .is_some_and(|s| parse(Some(s)).map_or(now, |d| d.with_timezone(&Utc)) > now);
    let member_name = match (&r.member_id, names) {
        (Some(id), Some(names)) if !id.is_empty() => names.get(id).cloned(),
        _ => None,
    };
    let kind_label = kind_info(&r.kind).map(|k| k.label.to_string()).unwrap_or_else(|| r.kind.clone());
    let dismissable = r.done_at.as_deref().is_none_or(|d| d.is_empty())
        && (gone || kind_info(&r.kind).is_some_and(|k| k.dismissable));
    json!({
        "id": r.id,
        "kind": r.kind,
        "kind_label": kind_label,
        "needs": r.needs,
        "project_id": r.project_id,
        "title": r.title,
        "body": r.body,
        "target_kind": r.target_kind,
        "target_id": r.target_id,
        "ticket_id": r.ticket_id,
        "page_id": r.page_id,
        "member_id": r.member_id,
        "member_name": member_name,
        "actor": r.actor,
        "count": r.count,
        "items": Value::Array(loads_list(Some(&r.items))),
        "data": Value::Object(data.clone()),
        "inapp": r.inapp,
        "desktop": r.desktop,
        "read": r.read_at.is_some(),
        "read_at": r.read_at,
        "done": r.done_at.is_some(),
        "done_at": r.done_at,
        "done_text": done_text(r, me),
        "done_by": r.done_by,
        "gone": gone,
        "gone_reason": data.get("gone_reason").cloned().unwrap_or(Value::Null),
        "snoozed": snoozed,
        "snoozed_until": if snoozed { json!(r.snoozed_until) } else { Value::Null },
        "cleared": r.cleared_at.is_some(),
        "cleared_at": r.cleared_at,
        "group_key": r.group_key,
        "event_id": r.event_id,
        "last_event_id": r.last_event_id,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
        "actions": actions(r, gone),
        "reminded": data.get("reminded_at").is_some_and(kb_base::pyjson::truthy),
        "dismissable": dismissable,
    })
}

/// member id -> name of the members named by these rows.
pub async fn member_names(session: &Session, rows: &[notification::Model]) -> Result<HashMap<String, String>> {
    let mut ids: Vec<String> = rows.iter().filter_map(|r| r.member_id.clone()).filter(|m| !m.is_empty()).collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ms = member::Entity::find().filter(member::Column::Id.is_in(ids)).all(session).await?;
    Ok(ms.into_iter().map(|m| (m.id, m.name)).collect())
}

/// The filters of the All notifications page.
pub const FILTERS: [&str; 6] = ["all", "unread", "needs", "snoozed", "done", "cleared"];

/// What `list_rows` takes besides the recipient.
#[derive(Debug, Clone)]
pub struct ListOptions {
    /// "panel" or "page".
    pub view: String,
    /// "needs" or "updates" (the panel's tabs).
    pub tab: Option<String>,
    /// One of `FILTERS` (the page's filter).
    pub filter: String,
    /// Search text.
    pub q: Option<String>,
    /// Only this project.
    pub project_id: Option<String>,
    /// Only these kinds.
    pub kinds: Option<Vec<String>>,
    /// ai | people | schedules | info | needs | docs.
    pub family: Option<String>,
    /// Only rows moved in the last this many days.
    pub days: Option<i64>,
    /// How many rows at most (1 to 500).
    pub limit: i64,
    /// Only rows older than this `updated_at`.
    pub before: Option<String>,
}

impl Default for ListOptions {
    fn default() -> Self {
        Self {
            view: "page".into(),
            tab: None,
            filter: "all".into(),
            q: None,
            project_id: None,
            kinds: None,
            family: None,
            days: None,
            limit: 100,
            before: None,
        }
    }
}

/// Rows of one recipient, newest activity first.
///
/// view "panel": the last 30 days, quiet rows left out, cleared rows left out, snoozed rows left out; `tab` needs
/// (Needs you, open first by waiting time, then today's done rows) or updates.
/// view "page": everything still kept, with `filter` (All, Unread, Needs you, Snoozed, Done, Cleared).
pub async fn list_rows(session: &Session, me: &str, opts: &ListOptions) -> Result<Value> {
    let now = utcnow();
    let mut stmt = rows_stmt(me, now, opts, opts.before.as_deref())?;
    if opts.view == "panel" {
        stmt = stmt.filter(not_snoozed(now));
    } else {
        stmt = where_page_filter(stmt, Some(&opts.filter), now);
    }
    let total = stmt.clone().count(session).await?;
    let ordered = if opts.view == "panel" && opts.tab.as_deref() == Some("needs") {
        // open first, the longest waiting first; then today's done rows, newest activity first
        let open_first = notification::Column::DoneAt.is_null();
        let waited: Expr = Expr::case(open_first, Expr::col(notification::Column::CreatedAt)).finally("").into();
        stmt.order_by(notification::Column::DoneAt.is_not_null(), Order::Asc)
            .order_by(waited, Order::Asc)
            .order_by(notification::Column::UpdatedAt, Order::Desc)
    } else {
        stmt.order_by(notification::Column::UpdatedAt, Order::Desc)
    };
    let page = ordered.limit(opts.limit.clamp(1, 500) as u64).all(session).await?;
    let names = member_names(session, &page).await?;
    let mut out: Vec<Value> = page.iter().map(|r| to_dict(r, me, Some(&names))).collect();
    let mut day_card = Value::Null;
    if opts.view == "panel" && opts.tab.as_deref() != Some("needs") {
        day_card = day_card_dict(session, me).await?;
    }
    if opts.view == "panel" {
        out.retain(|o| as_str(o.get("kind")) != Some("day_card"));
    }
    Ok(json!({
        "items": out,
        "total": total,
        "head": head_id(session).await?,
        "day_card": day_card,
        "now": iso(&now),
    }))
}

/// The query of `list_rows`: the recipient's rows narrowed by the view, the tab and the page's filters.
pub fn rows_stmt(
    me: &str,
    now: DateTime<Utc>,
    opts: &ListOptions,
    before: Option<&str>,
) -> Result<Select<notification::Entity>> {
    let mut stmt = notification::Entity::find().filter(notification::Column::Recipient.eq(me));
    if let Some(p) = opts.project_id.as_deref().filter(|p| !p.is_empty()) {
        stmt = stmt.filter(notification::Column::ProjectId.eq(p));
    }
    if let Some(kinds) = opts.kinds.as_ref().filter(|k| !k.is_empty()) {
        stmt = stmt.filter(notification::Column::Kind.is_in(kinds.iter().cloned()));
    }
    stmt = where_family(stmt, opts.family.as_deref());
    let mut days = opts.days;
    if opts.view == "panel" {
        days = Some(PANEL_DAYS);
        stmt = where_panel(stmt, opts.tab.as_deref(), now);
    }
    if let Some(days) = days.filter(|d| *d != 0) {
        let since = Duration::try_days(days)
            .and_then(|d| now.checked_sub_signed(d))
            .ok_or_else(|| NotifyError::Internal("date value out of range".into()))?;
        stmt = stmt.filter(notification::Column::UpdatedAt.gte(iso(&since)));
    }
    if let Some(before) = before.filter(|b| !b.is_empty()) {
        stmt = stmt.filter(notification::Column::UpdatedAt.lt(before));
    }
    if let Some(q) = opts.q.as_deref().filter(|q| !q.is_empty()) {
        stmt = where_search(stmt, q);
    }
    Ok(stmt)
}

/// The recipient's latest day card, the first row of the panel's Updates tab.
pub async fn day_card_dict(session: &Session, me: &str) -> Result<Value> {
    Ok(match latest_day_card(session, me).await? {
        Some(card) => to_dict(&card, me, None),
        None => Value::Null,
    })
}

/// The Docs family (NT-5): rows about a page (a comment, a mention) and the Docs kinds with no page.
pub const DOCS_KINDS: [&str; 2] = ["page_published", "access_request"];

/// Only the rows of a family: ai | people | schedules | info | needs | docs (any other value: every row).
pub fn where_family(stmt: Select<notification::Entity>, family: Option<&str>) -> Select<notification::Entity> {
    use notification::Column as C;
    match family {
        Some("needs") => stmt.filter(C::Needs.eq(true)),
        Some("docs") => stmt.filter(Condition::any().add(C::PageId.is_not_null()).add(C::Kind.is_in(DOCS_KINDS))),
        Some("ai") => stmt.filter(C::MemberId.is_not_null()),
        Some("people") => stmt.filter(C::MemberId.is_null()).filter(C::Kind.ne("day_card")),
        Some("schedules") => stmt.filter(C::Kind.is_in(["schedule", "schedule_started"])),
        Some("info") => stmt.filter(C::Needs.eq(false)),
        _ => stmt,
    }
}

/// The bell panel: rows shown in app and not cleared; the Needs you tab keeps open rows and today's done ones.
pub fn where_panel(
    stmt: Select<notification::Entity>,
    tab: Option<&str>,
    now: DateTime<Utc>,
) -> Select<notification::Entity> {
    use notification::Column as C;
    let stmt = stmt.filter(C::Inapp.eq(true)).filter(C::ClearedAt.is_null());
    match tab {
        Some("needs") => {
            let today0 = midnight(&local(&now)).with_timezone(&Utc);
            stmt.filter(C::Needs.eq(true))
                .filter(Condition::any().add(C::DoneAt.is_null()).add(C::DoneAt.gte(iso(&today0))))
        }
        Some("updates") => stmt.filter(C::Needs.eq(false)),
        _ => stmt,
    }
}

/// `ilike` of the text in the title, the body, the ticket and the items (lower-cased on both sides, as SQLAlchemy
/// writes it for an engine without ILIKE).
pub fn where_search(stmt: Select<notification::Entity>, q: &str) -> Select<notification::Entity> {
    use notification::Column as C;
    let like = format!("%{}%", q.trim());
    let one = |col: C| {
        Expr::expr(Func::lower(Expr::col(col)))
            .binary(BinOper::Like, Expr::cust_with_values("lower(?)", [like.clone()]))
    };
    stmt.filter(Condition::any().add(one(C::Title)).add(one(C::Body)).add(one(C::TicketId)).add(one(C::Items)))
}

/// Whether a row is hidden by a snooze that has not run out.
pub fn is_snoozed(r: &notification::Model, now: DateTime<Utc>) -> bool {
    r.snoozed_until
        .as_deref()
        .filter(|s| !s.is_empty())
        .is_some_and(|s| parse(Some(s)).map_or(now, |d| d.with_timezone(&Utc)) > now)
}

/// A row hidden by a snooze that has not run out (times are kept as UTC ISO text, so they compare as text).
pub fn snoozed(now: DateTime<Utc>) -> Condition {
    Condition::all().add(notification::Column::SnoozedUntil.gt(iso(&now)))
}

/// A row that is not hidden by a snooze.
pub fn not_snoozed(now: DateTime<Utc>) -> Condition {
    Condition::any()
        .add(notification::Column::SnoozedUntil.is_null())
        .add(notification::Column::SnoozedUntil.lte(iso(&now)))
}

/// The All notifications page's filter: all | unread | needs | snoozed | done | cleared.
pub fn where_page_filter(
    stmt: Select<notification::Entity>,
    filter: Option<&str>,
    now: DateTime<Utc>,
) -> Select<notification::Entity> {
    use notification::Column as C;
    match filter {
        Some("unread") => stmt.filter(C::ReadAt.is_null()).filter(C::ClearedAt.is_null()),
        Some("needs") => stmt.filter(C::Needs.eq(true)).filter(C::DoneAt.is_null()).filter(not_snoozed(now)),
        Some("snoozed") => stmt.filter(snoozed(now)),
        Some("done") => stmt.filter(C::DoneAt.is_not_null()),
        Some("cleared") => stmt.filter(C::ClearedAt.is_not_null()),
        _ => stmt.filter(C::ClearedAt.is_null()),
    }
}

/// The person's newest day card.
pub async fn latest_day_card(session: &Session, me: &str) -> Result<Option<notification::Model>> {
    Ok(notification::Entity::find()
        .filter(notification::Column::Recipient.eq(me))
        .filter(notification::Column::Kind.eq("day_card"))
        .order_by(notification::Column::CreatedAt, Order::Desc)
        .one(session)
        .await?)
}

/// The bell: the red number is open Needs you rows (not snoozed); a blue dot for unread updates. Counted in SQL, so
/// it costs the same however long the history is.
pub async fn counts(session: &Session, me: &str) -> Result<Value> {
    use notification::Column as C;
    let now = utcnow();
    let since = Duration::try_days(PANEL_DAYS)
        .and_then(|d| now.checked_sub_signed(d))
        .ok_or_else(|| NotifyError::Internal("date value out of range".into()))?;
    let since = iso(&since);
    let mine = || notification::Entity::find().filter(C::Recipient.eq(me));
    let shown = || Condition::all().add(C::Inapp.eq(true)).add(C::ClearedAt.is_null());
    let needs_open =
        || Condition::all().add(shown()).add(C::Needs.eq(true)).add(C::DoneAt.is_null()).add(not_snoozed(now));
    let updates = || Condition::all().add(shown()).add(C::Needs.eq(false)).add(C::UpdatedAt.gte(since.clone()));
    let needs = mine().filter(needs_open()).count(session).await?;
    let needs_unread = mine().filter(needs_open()).filter(C::ReadAt.is_null()).count(session).await?;
    let updates_unread =
        mine().filter(updates()).filter(C::ReadAt.is_null()).filter(not_snoozed(now)).count(session).await?;
    let n_updates = mine().filter(updates()).count(session).await?;
    let snoozed_n = mine().filter(snoozed(now)).count(session).await?;
    let unread_all = mine().filter(C::ReadAt.is_null()).filter(C::ClearedAt.is_null()).count(session).await?;
    let oldest: Option<Option<String>> = mine()
        .filter(needs_open())
        .select_only()
        .column_as(Expr::col(C::CreatedAt).min(), "oldest")
        .into_tuple::<Option<String>>()
        .one(session)
        .await?;
    Ok(json!({
        "needs": needs,
        "needs_unread": needs_unread,
        "updates_unread": updates_unread,
        "updates": n_updates,
        "snoozed": snoozed_n,
        "unread": unread_all,
        "head": head_id(session).await?,
        "oldest_needs_at": oldest.flatten(),
    }))
}

/// What moved since log id `since`, for this recipient: new or merged rows (toasts, the desktop notifier) and rows
/// closed since (a toast or a desktop notice for them is withdrawn). A cursor older than what the log still keeps
/// gets `cursor_too_old` and should start from `head`.
pub async fn feed(session: &Session, me: &str, since: Option<i64>) -> Result<Value> {
    let head = head_id(session).await?;
    let g = global(session).await?;
    let pruned = pruned_through(&g);
    // below what was deleted, or above the head (the database was restored or switched): start again from head
    let too_old = since.is_some_and(|s| s > 0 && (i128::from(s) < pruned || s > i64::from(head)));
    let Some(since) = since.filter(|_| !too_old) else {
        return Ok(json!({"head": head, "cursor_too_old": too_old, "items": [], "resolved": []}));
    };
    let rows = notification::Entity::find()
        .filter(notification::Column::Recipient.eq(me))
        .filter(notification::Column::LastEventId.gt(since))
        .all(session)
        .await?;
    let resolved_events = notify_event::Entity::find()
        .filter(notify_event::Column::Op.eq("resolve"))
        .filter(notify_event::Column::Id.gt(since))
        .all(session)
        .await?;
    let mut target_ids: Vec<String> = Vec::new();
    for e in &resolved_events {
        if let Some(t) = e.target_id.clone().filter(|t| !t.is_empty()) {
            if !target_ids.contains(&t) {
                target_ids.push(t);
            }
        }
    }
    let mut closed: Vec<String> = Vec::new();
    if !resolved_events.is_empty() {
        let cand = notification::Entity::find()
            .filter(notification::Column::Recipient.eq(me))
            .filter(notification::Column::DoneAt.is_not_null())
            .filter(notification::Column::TargetId.is_in(target_ids))
            .all(session)
            .await?;
        closed = cand.into_iter().map(|r| r.id).collect();
    }
    let prefs = get_prefs(session, me).await?;
    let names = member_names(session, &rows).await?;
    let mut sorted = rows;
    sorted.sort_by_key(|r| r.last_event_id);
    Ok(json!({
        "head": head,
        "cursor_too_old": false,
        "items": sorted.iter().map(|r| to_dict(r, me, Some(&names))).collect::<Vec<_>>(),
        "resolved": closed,
        "quiet": in_quiet_hours(&prefs, None),
        "dnd": truthy(prefs.get("dnd")),
        "sound": truthy(prefs.get("sound")),
        "sound_name": sound_name(&prefs),
    }))
}

/// `int(g.get("pruned_through") or 0)`.
pub fn pruned_through(g: &serde_json::Map<String, Value>) -> i128 {
    g.get("pruned_through").filter(|v| truthy(Some(v))).and_then(|v| crate::helpers::py_int(v).ok()).unwrap_or(0)
}

/// The raw log after an id (the planned `wait` tool and `kanban wait` read this). `readers`: the caller's recipient
/// keys, so only the events told to them, and every event of the projects they own or administer, come back; `None`
/// reads everything (the board's own user).
pub async fn log_since(
    session: &Session,
    since: i64,
    project_id: Option<&str>,
    limit: i64,
    readers: Option<&[String]>,
) -> Result<Value> {
    let head = head_id(session).await?;
    let g = global(session).await?;
    let pruned = pruned_through(&g);
    if since > 0 && (i128::from(since) < pruned || since > i64::from(head)) {
        return Ok(json!({"head": head, "cursor_too_old": true, "events": []}));
    }
    let mut stmt = notify_event::Entity::find().filter(notify_event::Column::Id.gt(since));
    if let Some(p) = project_id.filter(|p| !p.is_empty()) {
        stmt = stmt.filter(notify_event::Column::ProjectId.eq(p));
    }
    if let Some(readers) = readers {
        stmt = stmt.filter(readable_by(session, readers).await?);
    }
    let rows =
        stmt.order_by(notify_event::Column::Id, Order::Asc).limit(limit.clamp(1, 1000) as u64).all(session).await?;
    let events: Vec<Value> = rows
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "project_id": e.project_id,
                "kind": e.kind,
                "op": e.op,
                "needs": e.needs,
                "target_kind": e.target_kind,
                "target_id": e.target_id,
                "ticket_id": e.ticket_id,
                "page_id": e.page_id,
                "member_id": e.member_id,
                "actor": e.actor,
                "title": e.title,
                "body": e.body,
                "data": Value::Object(loads_map(Some(&e.data))),
                "recipients": Value::Array(loads_list(Some(&e.recipients))),
                "created_at": e.created_at,
            })
        })
        .collect();
    Ok(json!({"head": head, "cursor_too_old": false, "events": events}))
}

/// The log events these recipient keys may read: the ones told to them, and the events of the projects one of them
/// owns or administers (who are told every AI safety event there anyway).
pub async fn readable_by(session: &Session, readers: &[String]) -> Result<Condition> {
    let mut told = Condition::any().add(Expr::val(1).eq(0));
    for k in readers {
        // `col.contains(text, autoescape=True)`: `%`, `_` and the escape character are escaped with "/"
        let text = dumps(&json!(k)).replace('/', "//").replace('%', "/%").replace('_', "/_");
        let pattern = LikeExpr::new(format!("%{text}%")).escape('/');
        told = told.add(Expr::col(notify_event::Column::Recipients).like(pattern));
    }
    let mut managed: BTreeMap<String, ()> = BTreeMap::new();
    for k in readers {
        for p in managed_projects(session, k).await?.unwrap_or_default() {
            managed.insert(p, ());
        }
    }
    if !managed.is_empty() {
        told = told.add(notify_event::Column::ProjectId.is_in(managed.into_keys()));
    }
    Ok(told)
}
