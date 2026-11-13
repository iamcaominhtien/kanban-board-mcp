//! Part of `services/notifications.py`: lines 2547 to 2740, "A person acting on rows: read, dismiss, snooze, clear".

use kb_db::Session;
use kb_db::entities::notification;
use kb_db::sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter};
use serde_json::Value;

use crate::db::save_notification;
use crate::delivery::{announce, head_id};
use crate::error::{NotifyError, Result};
use crate::helpers::{iso, loads_map, now_iso, parse, utcnow};
use crate::kinds::kind_info;
use crate::reading::{FILTERS, ListOptions, rows_stmt, to_dict, where_page_filter};
use crate::resolving::resolve_rows;

/// One row of this recipient (`LookupError` for a row that is not theirs).
pub async fn mine(session: &Session, me: &str, row_id: &str) -> Result<notification::Model> {
    let r = notification::Entity::find_by_id(row_id).one(session).await?;
    r.filter(|r| r.recipient == me).ok_or_else(|| NotifyError::lookup("Notification not found"))
}

/// The All notifications page's filters, as `GET /notifications?view=page` takes them.
#[derive(Debug, Clone, Default)]
pub struct PageFilters {
    /// all | unread | needs | snoozed | done | cleared.
    pub filter: Option<String>,
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
}

impl PageFilters {
    /// `any(v not in (None, "", []) for v in page.values())`.
    fn any_set(&self) -> bool {
        self.filter.as_deref().is_some_and(|v| !v.is_empty())
            || self.q.as_deref().is_some_and(|v| !v.is_empty())
            || self.project_id.as_deref().is_some_and(|v| !v.is_empty())
            || self.kinds.as_ref().is_some_and(|v| !v.is_empty())
            || self.family.as_deref().is_some_and(|v| !v.is_empty())
            || self.days.is_some()
    }
}

/// Reading is not resolving: a Needs you row stays open, and Mark all read clears the count of unread, not the
/// list (the red number counts open work, not unread rows). With `all` and any of the page's filters, only the rows
/// that page lists are read.
pub async fn mark_read(
    session: &Session,
    me: &str,
    ids: Option<&[String]>,
    all: bool,
    tab: Option<&str>,
    page: &PageFilters,
) -> Result<i64> {
    let at = now_iso();
    let now = utcnow();
    let mut stmt = if let Some(ids) = ids.filter(|i| !i.is_empty()) {
        notification::Entity::find()
            .filter(notification::Column::Recipient.eq(me))
            .filter(notification::Column::Id.is_in(ids.iter().cloned()))
    } else if !all {
        return Ok(0);
    } else if page.any_set() {
        if let Some(f) = page.filter.as_deref() {
            if !FILTERS.contains(&f) {
                return Err(NotifyError::value(format!("filter must be one of {}", FILTERS.join(", "))));
            }
        }
        let opts = ListOptions {
            view: "page".into(),
            q: page.q.clone(),
            project_id: page.project_id.clone(),
            kinds: page.kinds.clone(),
            family: page.family.clone(),
            days: page.days,
            ..Default::default()
        };
        let stmt = rows_stmt(me, now, &opts, None)?;
        let filter = page.filter.as_deref().filter(|f| !f.is_empty()).unwrap_or("all");
        where_page_filter(stmt, Some(filter), now)
    } else {
        notification::Entity::find().filter(notification::Column::Recipient.eq(me))
    };
    stmt = stmt.filter(notification::Column::ReadAt.is_null());
    match tab {
        Some("needs") => stmt = stmt.filter(notification::Column::Needs.eq(true)),
        Some("updates") => stmt = stmt.filter(notification::Column::Needs.eq(false)),
        _ => {}
    }
    let rows = stmt.all(session).await?;
    for r in &rows {
        let mut after = r.clone();
        after.read_at = Some(at.clone());
        save_notification(session, r, &after).await?;
    }
    session.commit().await?;
    if !rows.is_empty() {
        announce(Some(head_id(session).await?)).await;
    }
    Ok(rows.len() as i64)
}

/// Opening what a row points at marks it read (not done).
pub async fn mark_target_read(session: &Session, me: &str, target_kind: &str, target_id: &str) -> Result<i64> {
    use notification::Column as C;
    let mut any =
        Condition::any().add(Condition::all().add(C::TargetKind.eq(target_kind)).add(C::TargetId.eq(target_id)));
    if target_kind == "ticket" {
        any = any.add(C::TicketId.eq(target_id));
    }
    if target_kind == "page" {
        any = any.add(C::PageId.eq(target_id));
    }
    let rows = notification::Entity::find()
        .filter(C::Recipient.eq(me))
        .filter(any)
        .filter(C::ReadAt.is_null())
        .all(session)
        .await?;
    let at = now_iso();
    for r in &rows {
        let mut after = r.clone();
        after.read_at = Some(at.clone());
        save_notification(session, r, &after).await?;
    }
    session.commit().await?;
    if !rows.is_empty() {
        announce(Some(head_id(session).await?)).await;
    }
    Ok(rows.len() as i64)
}

/// Kinds addressed to each recipient on their own: dismissing one closes only the caller's row (a mention of you is
/// not a mention of the others in the thread).
pub const PER_RECIPIENT_KINDS: [&str; 1] = ["mention"];

/// Dismiss resolves: the row goes grey with "Dismissed by you", for every recipient of the same thing (shared work,
/// such as a failed run). A mention is the caller's own: only their row closes.
pub async fn dismiss(session: &Session, me: &str, row_id: &str, by: &str) -> Result<Value> {
    let r = mine(session, me, row_id).await?;
    let gone = loads_map(Some(&r.data)).get("gone").is_some_and(kb_base::pyjson::truthy);
    if r.done_at.as_deref().is_some_and(|d| !d.is_empty()) {
        return Ok(to_dict(&r, me, None));
    }
    if !r.needs {
        return Err(NotifyError::value("Only a Needs you row is dismissed; clear an update instead."));
    }
    if !(gone || kind_info(&r.kind).is_some_and(|k| k.dismissable)) {
        return Err(NotifyError::value("This one closes when the work is done; it cannot be dismissed."));
    }
    let mut stmt = notification::Entity::find()
        .filter(notification::Column::GroupKey.eq(r.group_key.clone()))
        .filter(notification::Column::DoneAt.is_null());
    if PER_RECIPIENT_KINDS.contains(&r.kind.as_str()) {
        stmt = stmt.filter(notification::Column::Recipient.eq(me));
    }
    let same = stmt.all(session).await?;
    resolve_rows(session, same, "Dismissed by {who}", Some(by), false).await?;
    let fresh = notification::Entity::find_by_id(row_id).one(session).await?.unwrap_or(r);
    Ok(to_dict(&fresh, me, None))
}

/// Hide a row until a time (1 hour, this evening, tomorrow morning). It never clears the work.
pub async fn snooze(session: &Session, me: &str, row_id: &str, until: Option<&str>) -> Result<Value> {
    let r = mine(session, me, row_id).await?;
    let mut after = r.clone();
    match until {
        Some(until) => {
            let when = parse(Some(until));
            match when {
                Some(w) if w > utcnow() => {
                    after.snoozed_until = Some(iso(&w.with_timezone(&chrono::Utc)));
                }
                _ => return Err(NotifyError::value("Snooze until a time in the future.")),
            }
        }
        None => after.snoozed_until = None,
    }
    save_notification(session, &r, &after).await?;
    session.commit().await?;
    announce(Some(head_id(session).await?)).await;
    Ok(to_dict(&after, me, None))
}

/// The x on a row: it leaves the panel and stays on the page under Cleared. Clearing is a state, not a delete. An
/// open Needs you row is resolved or snoozed instead.
pub async fn clear(session: &Session, me: &str, row_id: &str, on: bool) -> Result<Value> {
    let r = mine(session, me, row_id).await?;
    if on && r.needs && r.done_at.as_deref().is_none_or(str::is_empty) {
        return Err(NotifyError::value(
            "A Needs you row closes when the work is done, or is snoozed; it is not cleared.",
        ));
    }
    let mut after = r.clone();
    after.cleared_at = if on { Some(now_iso()) } else { None };
    if on && r.read_at.is_none() {
        after.read_at = after.cleared_at.clone();
    }
    save_notification(session, &r, &after).await?;
    session.commit().await?;
    announce(Some(head_id(session).await?)).await;
    Ok(to_dict(&after, me, None))
}

/// Clear every read update (the panel's Clear).
pub async fn clear_read(session: &Session, me: &str) -> Result<i64> {
    use notification::Column as C;
    let rows = notification::Entity::find()
        .filter(C::Recipient.eq(me))
        .filter(C::Needs.eq(false))
        .filter(C::ReadAt.is_not_null())
        .filter(C::ClearedAt.is_null())
        .all(session)
        .await?;
    let at = now_iso();
    for r in &rows {
        let mut after = r.clone();
        after.cleared_at = Some(at.clone());
        save_notification(session, r, &after).await?;
    }
    session.commit().await?;
    if !rows.is_empty() {
        announce(Some(head_id(session).await?)).await;
    }
    Ok(rows.len() as i64)
}
