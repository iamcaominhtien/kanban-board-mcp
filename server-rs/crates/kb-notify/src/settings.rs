//! Part of `services/notifications.py`: lines 323 to 532, "Settings > Notifications".

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use kb_db::Session;
use kb_db::entities::notify_prefs;
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue, EntityTrait};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::delivery::{announce, head_id};
use crate::error::{NotifyError, Result};
use crate::follow::muted_list;
use crate::helpers::{as_str, dumps, loads_map, local, now_iso, py_int, truthy, utcnow};
use crate::kinds::{
    DEFAULT_RETENTION_DAYS, KINDS, REMIND_MAX_MIN, SOUND_NAMES, default_prefs, info_kinds, kind_info, needs_kinds,
};
use crate::recipients::may_manage;

/// A recipient's settings: a JSON object kept in key order, as a Python dict is.
pub type Prefs = Map<String, Value>;

static HHMM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{2}:\d{2}$").expect("the HH:MM pattern is a valid regex"));

fn default_map() -> Prefs {
    match default_prefs() {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// A recipient's settings, with the defaults filled in.
pub async fn get_prefs(session: &Session, recipient: &str) -> Result<Prefs> {
    let row = notify_prefs::Entity::find_by_id(recipient).one(session).await?;
    Ok(prefs_of(row.as_ref()))
}

/// Settings from a stored row (`None`: never saved), with the defaults filled in.
pub fn prefs_of(row: Option<&notify_prefs::Model>) -> Prefs {
    let mine = row.map(|r| loads_map(Some(&r.prefs))).unwrap_or_default();
    let mut out = default_map();
    for (k, v) in mine {
        match (&v, out.get_mut(&k)) {
            (Value::Object(update), Some(Value::Object(target))) => {
                for (k2, v2) in update {
                    target.insert(k2.clone(), v2.clone());
                }
            }
            _ => {
                out.insert(k, v);
            }
        }
    }
    out
}

/// (in app, desktop) for a kind. In app is locked on for Needs you.
pub fn event_switch(prefs: &Prefs, kind: &str) -> (bool, bool) {
    let (needs, desktop_default) = kind_info(kind).map(|k| (k.needs, k.desktop)).unwrap_or((false, false));
    let empty = Map::new();
    let mine = prefs
        .get("events")
        .and_then(Value::as_object)
        .and_then(|e| e.get(kind))
        .filter(|v| kb_base::pyjson::truthy(v))
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let inapp = if needs { true } else { mine.get("inapp").is_none_or(kb_base::pyjson::truthy) };
    let desktop = prefs.get("desktop_on").is_none_or(kb_base::pyjson::truthy)
        && mine.get("desktop").map_or(desktop_default, kb_base::pyjson::truthy);
    (inapp, desktop)
}

/// How long notifications and the log are kept (one app-wide setting).
pub async fn retention_days(session: &Session) -> Result<i64> {
    let row = notify_prefs::Entity::find_by_id("*").one(session).await?;
    let days = row.as_ref().and_then(|r| loads_map(Some(&r.prefs)).get("retention_days").cloned());
    let Some(days) = days.filter(kb_base::pyjson::truthy) else {
        return Ok(DEFAULT_RETENTION_DAYS);
    };
    Ok(match py_int(&days) {
        Ok(n) => n.max(1).min(i128::from(i64::MAX)) as i64,
        Err(_) => DEFAULT_RETENTION_DAYS,
    })
}

/// The app-wide row `"*"` as an object.
pub async fn global(session: &Session) -> Result<Map<String, Value>> {
    let row = notify_prefs::Entity::find_by_id("*").one(session).await?;
    Ok(row.map(|r| loads_map(Some(&r.prefs))).unwrap_or_default())
}

/// Change keys of the app-wide row `"*"` (the caller commits).
pub async fn set_global(session: &Session, values: &[(&str, Value)]) -> Result<()> {
    let row = notify_prefs::Entity::find_by_id("*").one(session).await?;
    let mut g = row.as_ref().map(|r| loads_map(Some(&r.prefs))).unwrap_or_default();
    for (k, v) in values {
        g.insert((*k).to_string(), v.clone());
    }
    save_prefs(session, row, "*", dumps(&Value::Object(g))).await
}

/// `session.add(row)` of a `NotifyPrefs` row: an update of what changed when it exists (`row` as it was read), else
/// an insert.
async fn save_prefs(session: &Session, row: Option<notify_prefs::Model>, recipient: &str, prefs: String) -> Result<()> {
    match row {
        Some(row) => {
            let mut row = kb_db::edit(row);
            row.prefs = ActiveValue::Set(prefs);
            row.updated_at = ActiveValue::Set(now_iso());
            row.update(session).await?;
        }
        None => {
            let mut row = notify_prefs::new();
            row.recipient = ActiveValue::Set(recipient.to_string());
            row.prefs = ActiveValue::Set(prefs);
            row.updated_at = ActiveValue::Set(now_iso());
            row.insert(session).await?;
        }
    }
    Ok(())
}

/// `value` when it is text of the form `HH:MM`, else the fallback.
pub fn hhmm(value: Option<&Value>, fallback: &str) -> String {
    match as_str(value) {
        Some(v) if HHMM.is_match(v) => v.to_string(),
        _ => fallback.to_string(),
    }
}

/// The Settings > Notifications page: the event table, quiet hours, sound, the day card, retention, Muted.
pub async fn settings_for(session: &Session, recipient: &str) -> Result<Value> {
    let prefs = get_prefs(session, recipient).await?;
    let mut events = Vec::new();
    for k in needs_kinds().chain(info_kinds()) {
        // the table shows each kind's own choice; the master switch is shown on its own
        let mut shown = prefs.clone();
        shown.insert("desktop_on".into(), json!(true));
        let (inapp, desktop) = event_switch(&shown, k.name);
        events.push(json!({
            "kind": k.name,
            "label": k.label,
            "needs": k.needs,
            "inapp": inapp,
            "inapp_locked": k.needs,
            "desktop": desktop,
        }));
    }
    let get = |key: &str| prefs.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "events": events,
        "quiet": get("quiet"),
        "desktop_on": prefs.get("desktop_on").is_none_or(kb_base::pyjson::truthy),
        "dnd": truthy(prefs.get("dnd")),
        "sound": truthy(prefs.get("sound")),
        "sound_name": sound_name(&prefs),
        "remind_after_min": remind_after(&prefs),
        "day_card": get("day_card"),
        "retention_days": retention_days(session).await?,
        "retention_editable": may_manage(session, recipient).await?,
        "muted": muted_list(session, recipient).await?,
    }))
}

/// The sound the person picked; an unknown name falls back to the first.
pub fn sound_name(prefs: &Prefs) -> &'static str {
    match as_str(prefs.get("sound_name")) {
        Some(name) => SOUND_NAMES.iter().find(|s| **s == name).copied().unwrap_or(SOUND_NAMES[0]),
        None => SOUND_NAMES[0],
    }
}

/// Minutes before an unanswered Needs you row reminds once; 0 when reminders are off.
pub fn remind_after(prefs: &Prefs) -> i64 {
    let default = 15;
    let value = prefs.get("remind_after_min").cloned().unwrap_or(json!(default));
    match py_int(&value) {
        Ok(m) if (0..=i128::from(REMIND_MAX_MIN)).contains(&m) => m as i64,
        _ => default,
    }
}

/// The per-kind In app and desktop choices. A Needs you kind's In app cannot be switched off.
pub fn apply_event_choices(mine: &mut Prefs, events: &[Value]) -> Result<()> {
    for item in events {
        let Some(item) = item.as_object() else {
            return Err(NotifyError::Internal("'str' object has no attribute 'get'".into()));
        };
        let kind_value = item.get("kind").cloned().unwrap_or(Value::Null);
        if matches!(kind_value, Value::Array(_) | Value::Object(_)) {
            return Err(NotifyError::Internal("unhashable type".into()));
        }
        let kind = as_str(Some(&kind_value)).filter(|k| KINDS.iter().any(|x| x.name == *k));
        let Some(kind) = kind else {
            return Err(NotifyError::value(format!("Unknown kind: {}", kb_base::pyjson::py_str(&kind_value))));
        };
        let events_map = match mine.entry("events").or_insert_with(|| json!({})) {
            Value::Object(map) => map,
            other => {
                *other = json!({});
                other.as_object_mut().ok_or_else(|| NotifyError::Internal("settings events".into()))?
            }
        };
        let mut cur: Map<String, Value> = events_map
            .get(kind)
            .filter(|v| kb_base::pyjson::truthy(v))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(inapp) = item.get("inapp").filter(|v| !v.is_null()) {
            let needs = kind_info(kind).is_some_and(|k| k.needs);
            if needs && !kb_base::pyjson::truthy(inapp) {
                return Err(NotifyError::value(
                    "In app stays on for everything that needs you: an AI waiting on an answer with no row and no \
                     count would wait for ever. Only its desktop notification can be switched off.",
                ));
            }
            cur.insert("inapp".into(), json!(kb_base::pyjson::truthy(inapp)));
        }
        if let Some(desktop) = item.get("desktop").filter(|v| !v.is_null()) {
            cur.insert("desktop".into(), json!(kb_base::pyjson::truthy(desktop)));
        }
        events_map.insert(kind.to_string(), Value::Object(cur));
    }
    Ok(())
}

fn object_of(value: Option<&Value>) -> Map<String, Value> {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// Quiet hours: on, start, end.
pub fn apply_quiet(mine: &mut Prefs, src: &Map<String, Value>) {
    let defaults = object_of(default_map().get("quiet"));
    let mut q = defaults;
    for (k, v) in object_of(mine.get("quiet")) {
        q.insert(k, v);
    }
    if let Some(on) = src.get("on") {
        q.insert("on".into(), json!(kb_base::pyjson::truthy(on)));
    }
    for k in ["start", "end"] {
        if let Some(v) = src.get(k) {
            let current = as_str(q.get(k)).unwrap_or("").to_string();
            q.insert(k.into(), json!(hhmm(Some(v), &current)));
        }
    }
    mine.insert("quiet".into(), Value::Object(q));
}

/// The day card: on, time, days.
pub fn apply_day_card(mine: &mut Prefs, src: &Map<String, Value>) -> Result<()> {
    let mut d = object_of(default_map().get("day_card"));
    for (k, v) in object_of(mine.get("day_card")) {
        d.insert(k, v);
    }
    if let Some(on) = src.get("on") {
        d.insert("on".into(), json!(kb_base::pyjson::truthy(on)));
    }
    if let Some(t) = src.get("time") {
        let current = as_str(d.get("time")).unwrap_or("").to_string();
        d.insert("time".into(), json!(hhmm(Some(t), &current)));
    }
    if let Some(Value::Array(days)) = src.get("days") {
        let mut set = std::collections::BTreeSet::new();
        for x in days {
            let n = py_int(x)?;
            if (0..=6).contains(&n) {
                set.insert(n as i64);
            }
        }
        d.insert("days".into(), json!(set.into_iter().collect::<Vec<_>>()));
    }
    mine.insert("day_card".into(), Value::Object(d));
    Ok(())
}

/// Save part of a recipient's settings. A Needs you kind's In app cannot be switched off (`ValueError`). The
/// app-wide `retention_days` deletes everyone's history: only the board's own user or an owner or admin of a
/// project changes it (`PermissionError`).
pub async fn update_settings(session: &Session, recipient: &str, body: &Map<String, Value>) -> Result<Value> {
    let retention = body.get("retention_days").filter(|v| !v.is_null());
    if retention.is_some() && !may_manage(session, recipient).await? {
        return Err(NotifyError::Permission(
            "Only the board's own user, or an owner or admin of a project, changes how long notifications are kept."
                .into(),
        ));
    }
    let row = notify_prefs::Entity::find_by_id(recipient).one(session).await?;
    let mut mine = row.as_ref().map(|r| loads_map(Some(&r.prefs))).unwrap_or_default();
    match body.get("events").filter(|v| kb_base::pyjson::truthy(v)) {
        None => {}
        Some(Value::Array(events)) => apply_event_choices(&mut mine, events)?,
        Some(_) => return Err(NotifyError::Internal("settings events".into())),
    }
    if let Some(Value::Object(quiet)) = body.get("quiet") {
        apply_quiet(&mut mine, quiet);
    }
    for k in ["dnd", "sound", "desktop_on"] {
        if let Some(v) = body.get(k).filter(|v| !v.is_null()) {
            mine.insert(k.into(), json!(kb_base::pyjson::truthy(v)));
        }
    }
    if let Some(name) = body.get("sound_name").filter(|v| !v.is_null()) {
        match as_str(Some(name)).filter(|n| SOUND_NAMES.contains(n)) {
            Some(n) => {
                mine.insert("sound_name".into(), json!(n));
            }
            None => return Err(NotifyError::value(format!("Pick a sound: {}.", SOUND_NAMES.join(", ")))),
        }
    }
    if let Some(v) = body.get("remind_after_min").filter(|v| !v.is_null()) {
        let minutes = py_int(v)?;
        if !(0..=i128::from(REMIND_MAX_MIN)).contains(&minutes) {
            return Err(NotifyError::value("Remind after 1 to 1440 minutes, or 0 for never."));
        }
        mine.insert("remind_after_min".into(), json!(minutes as i64));
    }
    if let Some(Value::Object(day_card)) = body.get("day_card") {
        apply_day_card(&mut mine, day_card)?;
    }
    let days = match retention {
        Some(v) => {
            let days = py_int(v)?;
            if !(1..=3650).contains(&days) {
                return Err(NotifyError::value("Keep notifications for 1 to 3650 days."));
            }
            Some(days as i64)
        }
        None => None,
    };
    save_prefs(session, row, recipient, dumps(&Value::Object(mine))).await?;
    if let Some(days) = days {
        set_global(session, &[("retention_days", json!(days))]).await?;
    }
    session.commit().await?;
    announce(Some(head_id(session).await?)).await;
    settings_for(session, recipient).await
}

/// Whether quiet hours are on now for these settings.
pub fn in_quiet_hours(prefs: &Prefs, at: Option<DateTime<Utc>>) -> bool {
    let empty = Map::new();
    let q = prefs.get("quiet").filter(|v| kb_base::pyjson::truthy(v)).and_then(Value::as_object).unwrap_or(&empty);
    if !q.get("on").is_some_and(kb_base::pyjson::truthy) {
        return false;
    }
    let t = local(&at.unwrap_or_else(utcnow)).format("%H:%M").to_string();
    let start = as_str(q.get("start")).unwrap_or("22:00");
    let end = as_str(q.get("end")).unwrap_or("08:00");
    if start == end {
        return false;
    }
    if start < end { start <= t.as_str() && t.as_str() < end } else { t.as_str() >= start || t.as_str() < end }
}
