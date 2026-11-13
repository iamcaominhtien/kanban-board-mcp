//! Port of `server/api/notifications.py`: the caller's rows across every project, the bell's counts, the feed since
//! a log id, read / dismiss / snooze / clear, the settings, follow and mute, the day card, and the raw event log.
//! The caller is the person of the request (X-Actor, or the board's own user).

use axum::Json;
use axum::extract::RawQuery;
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, activity};
use serde_json::{Map, Value, json};

use crate::acting::{PageFilters, clear, clear_read, dismiss, mark_read, mark_target_read, snooze};
use crate::daycard::{build_day_card, write_day_cards};
use crate::error::NotifyError;
use crate::follow::{follow_state, set_follow, unmute};
use crate::helpers::{local, midnight, person_key, utcnow};
use crate::reading::{FILTERS, ListOptions, counts, feed, list_rows, log_since};
use crate::recipients::recipient_keys;
use crate::resolving::reconcile;
use crate::schemas::{ClearBody, FollowBody, KindField, OpenedBody, Params, ReadBody, SnoozeBody};
use crate::settings::{settings_for, update_settings};

/// Every route of this area (the app merges them, in the order the Python app included its routers).
pub fn routes() -> Routes {
    Routes::new()
        .get("/notifications", list_notifications)
        .get("/notifications/counts", get_counts)
        .get("/notifications/feed", get_feed)
        .get("/notifications/log", get_log)
        .post("/notifications/read", post_read)
        .post("/notifications/opened", post_opened)
        .post("/notifications/{row_id}/dismiss", post_dismiss)
        .post("/notifications/{row_id}/snooze", post_snooze)
        .post("/notifications/{row_id}/clear", post_clear)
        .post("/notifications/clear-read", post_clear_read)
        .get("/notifications/settings", get_settings)
        .patch("/notifications/settings", patch_settings)
        .get("/notifications/follow", get_follow)
        .put("/notifications/follow", put_follow)
        .delete("/notifications/follow/{follow_id}", delete_follow)
        .get("/notifications/day-card", get_day_card)
        .post("/notifications/day-card", post_day_card)
}

/// `_by()`: the caller's name.
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// `_me()`: the caller's recipient key.
fn me() -> String {
    person_key(Some(&by()))
}

/// Statuses for the exceptions a call can raise: (`LookupError`, `ValueError`, `PermissionError`).
fn bad(err: NotifyError, lookup: u16, value: u16, permission: u16) -> ApiError {
    match err {
        NotifyError::Lookup(_) => err.into_api(lookup),
        NotifyError::Value(_) => err.into_api(value),
        NotifyError::Permission(_) => err.into_api(permission),
        other => other.into_api(500),
    }
}

/// The caller's rows, newest activity first. `view=panel&tab=needs|updates` is the bell panel (30 days, quiet,
/// cleared and snoozed rows left out); `view=page` is All notifications with `filter` all | unread | needs | snoozed
/// | done | cleared, search `q`, `project_id`, `kind`, `family` (ai | people | schedules | info | needs | docs),
/// `days`.
async fn list_notifications(RawQuery(raw): RawQuery) -> ApiResult<Json<Value>> {
    let mut p = Params::new(raw.as_deref());
    let opts = ListOptions {
        view: p.text("view", "page"),
        tab: p.opt("tab"),
        filter: p.text("filter", "all"),
        q: p.opt("q"),
        project_id: p.opt("project_id"),
        kinds: p.many("kind"),
        family: p.opt("family"),
        days: p.opt_int("days"),
        limit: p.int("limit", 100),
        before: p.opt("before"),
    };
    p.finish()?;
    if !FILTERS.contains(&opts.filter.as_str()) {
        return Err(ApiError::unprocessable(format!("filter must be one of {}", FILTERS.join(", "))));
    }
    reconcile().await.map_err(|e| e.into_api(500))?;
    let session = kb_db::session();
    Ok(Json(list_rows(&session, &me(), &opts).await.map_err(|e| e.into_api(500))?))
}

/// The bell: `needs` (the red number), `updates_unread` (the blue dot), `snoozed`, `head` (the log's newest id).
async fn get_counts() -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(counts(&session, &me()).await.map_err(|e| e.into_api(500))?))
}

/// Rows new or merged since log id `since` and rows closed since, for toasts and the desktop notifier. Without
/// `since` only `head` comes back (a first load never replays old news); a cursor older than the log returns
/// `cursor_too_old: true`: start from `head`.
async fn get_feed(RawQuery(raw): RawQuery) -> ApiResult<Json<Value>> {
    let mut p = Params::new(raw.as_deref());
    let since = p.opt_int("since");
    p.finish()?;
    reconcile().await.map_err(|e| e.into_api(500))?;
    let session = kb_db::session();
    Ok(Json(feed(&session, &me(), since).await.map_err(|e| e.into_api(500))?))
}

/// The event log after an id, oldest first (what an external AI waiting on the board will read). The board's own
/// user reads every event; anyone else the events told to them (an AI member as `ai:<id>`, or by its name in
/// `project_id`) and every event of the projects they own or administer.
async fn get_log(RawQuery(raw): RawQuery) -> ApiResult<Json<Value>> {
    let mut p = Params::new(raw.as_deref());
    let since = p.int("since", 0);
    let project_id = p.opt("project_id");
    let limit = p.int("limit", 200);
    p.finish()?;
    let session = kb_db::session();
    let me = me();
    let mut readers: Option<Vec<String>> = None;
    if me != "user" {
        let mut list = vec![me.clone()];
        if let Some(pid) = project_id.as_deref().filter(|p| !p.is_empty()) {
            let by = by();
            for k in recipient_keys(&session, Some(pid), &[Some(by.as_str())]).await.map_err(|e| e.into_api(500))? {
                if !list.contains(&k) {
                    list.push(k);
                }
            }
        }
        readers = Some(list);
    }
    let out = log_since(&session, since, project_id.as_deref(), limit, readers.as_deref())
        .await
        .map_err(|e| e.into_api(500))?;
    Ok(Json(out))
}

/// Mark rows read (`ids`), or all of a tab (`all`, `tab` needs | updates); with `all` and any of the page's filters
/// (`filter`, `q`, `project_id`, `kind`, `family`, `days`) only the rows that page lists. Reading is not resolving.
async fn post_read(Body(body): Body<ReadBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let kinds = match body.kind {
        Some(KindField::One(k)) => Some(vec![k]),
        Some(KindField::Many(k)) => Some(k),
        None => None,
    };
    let page = PageFilters {
        filter: body.filter,
        q: body.q,
        project_id: body.project_id,
        kinds,
        family: body.family,
        days: body.days,
    };
    let read = mark_read(&session, &me(), body.ids.as_deref(), body.all, body.tab.as_deref(), &page)
        .await
        .map_err(|e| bad(e, 500, 422, 500))?;
    Ok(Json(json!({"read": read})))
}

/// The person opened what rows point at (a ticket, a page, a run): those rows are read, not done.
async fn post_opened(Body(body): Body<OpenedBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let n = mark_target_read(&session, &me(), &body.target_kind, &body.target_id).await.map_err(|e| e.into_api(500))?;
    Ok(Json(json!({"read": n})))
}

/// Dismiss resolves the thing for everyone it was addressed to ("Dismissed by you").
async fn post_dismiss(Path(row_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(dismiss(&session, &me(), &row_id, &by()).await.map_err(|e| bad(e, 404, 409, 500))?))
}

/// Hide a row until a time; `until: null` brings it back now.
async fn post_snooze(Path(row_id): Path<String>, Body(body): Body<SnoozeBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(snooze(&session, &me(), &row_id, body.until.as_deref()).await.map_err(|e| bad(e, 404, 422, 500))?))
}

/// Clear a row (it stays on the page under Cleared); `on: false` puts it back. The body is optional.
async fn post_clear(Path(row_id): Path<String>, body: axum::body::Bytes) -> ApiResult<Json<Value>> {
    let on = if body.is_empty() {
        true
    } else {
        match serde_json::from_slice::<Option<ClearBody>>(&body) {
            Ok(parsed) => parsed.map(|b| b.on).unwrap_or(true),
            Err(err) => {
                let (kind, msg) = if err.is_data() {
                    ("value_error", err.to_string())
                } else {
                    ("json_invalid", format!("JSON decode error: {err}"))
                };
                return Err(ApiError::validation(&["body"], msg, kind));
            }
        }
    };
    let session = kb_db::session();
    Ok(Json(clear(&session, &me(), &row_id, on).await.map_err(|e| bad(e, 404, 409, 500))?))
}

/// Clear every read update.
async fn post_clear_read() -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let n = clear_read(&session, &me()).await.map_err(|e| e.into_api(500))?;
    Ok(Json(json!({"cleared": n})))
}

/// Settings > Notifications of the caller.
async fn get_settings() -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(settings_for(&session, &me()).await.map_err(|e| e.into_api(500))?))
}

/// Change part of the settings: `events` [{kind, inapp?, desktop?}] (In app is locked on for Needs you), `quiet`
/// {on, start, end}, `dnd`, `sound`, `day_card` {on, time, days}, `retention_days`.
async fn patch_settings(Body(body): Body<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(update_settings(&session, &me(), &body).await.map_err(|e| bad(e, 500, 422, 403))?))
}

/// What the bell on a ticket, page or space shows for the caller.
async fn get_follow(RawQuery(raw): RawQuery) -> ApiResult<Json<Value>> {
    let mut p = Params::new(raw.as_deref());
    let scope = p.required("scope");
    let scope_id = p.required("scope_id");
    p.finish()?;
    let session = kb_db::session();
    Ok(Json(follow_state(&session, &me(), &scope, &scope_id).await.map_err(|e| e.into_api(500))?))
}

/// Follow, mute or forget a ticket, page, Docs space, project or kind.
async fn put_follow(Body(body): Body<FollowBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = set_follow(
        &session,
        &me(),
        &body.scope,
        &body.scope_id,
        body.level.as_deref(),
        body.project_id.as_deref(),
        body.minutes,
        &body.label,
    )
    .await
    .map_err(|e| bad(e, 500, 422, 500))?;
    Ok(Json(out))
}

/// Unmute (or stop following) from the Muted list.
async fn delete_follow(Path(follow_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    unmute(&session, &me(), &follow_id).await.map_err(|e| bad(e, 404, 500, 500))?;
    Ok(Json(json!({"deleted": true})))
}

/// The caller's latest day card; `preview=true` counts today so far without writing a card.
async fn get_day_card(RawQuery(raw): RawQuery) -> ApiResult<Json<Value>> {
    let mut p = Params::new(raw.as_deref());
    let preview = p.boolean("preview", false);
    p.finish()?;
    let session = kb_db::session();
    let me = me();
    if preview {
        let now = utcnow();
        let since = midnight(&local(&now));
        let card = build_day_card(&session, &me, since, now.fixed_offset()).await.map_err(|e| e.into_api(500))?;
        return Ok(Json(json!({"card": null, "preview": card})));
    }
    let opts = ListOptions { view: "panel".into(), tab: Some("updates".into()), limit: 1, ..Default::default() };
    let data = list_rows(&session, &me, &opts).await.map_err(|e| e.into_api(500))?;
    Ok(Json(json!({"card": data.get("day_card").cloned().unwrap_or(Value::Null), "preview": null})))
}

/// Write the caller's day card now (the time is a setting; this is for "Sum up today" and tests).
async fn post_day_card() -> ApiResult<Json<Value>> {
    let n = write_day_cards(None, Some(&me())).await.map_err(|e| e.into_api(500))?;
    Ok(Json(json!({"written": n})))
}
