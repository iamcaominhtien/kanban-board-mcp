//! Notifications and activity (`services/ai/schedules.py` lines 1113 to 1200): `_notify`, `events_since`,
//! `_activity`.

use kb_ai::store::{loads, now_iso};
use kb_base::{activity, ctx, pyjson};
use kb_db::database;
use kb_db::entities::{ai_schedule, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, DbErr, EntityTrait, IntoActiveModel};
use kb_notify::writing::{EmitFields, PendingEvent, enqueue};
use serde_json::{Map, Value, json};

use super::{EVENTS_KEPT, NOTIFY_EVENTS, RT};

/// `event in loads(s.notify, list(NOTIFY_EVENTS))`.
fn wants(s: &ai_schedule::Model, event: &str) -> bool {
    match loads(Some(&s.notify), json!(NOTIFY_EVENTS)) {
        Value::Array(events) => events.iter().any(|e| e.as_str() == Some(event)),
        Value::Object(map) => map.contains_key(event),
        Value::String(text) => text.contains(event),
        _ => false,
    }
}

/// `[s.created_by, *loads(s.notify_people, [])]`: who a schedule tells.
fn people(s: &ai_schedule::Model) -> Vec<Value> {
    let mut out = vec![json!(s.created_by)];
    if let Value::Array(more) = loads(Some(&s.notify_people), json!([])) {
        out.extend(more);
    }
    out
}

fn names_of(people: &[Value]) -> Vec<Option<String>> {
    people
        .iter()
        .map(|p| match p {
            Value::Null => None,
            Value::String(name) => Some(name.clone()),
            other => Some(pyjson::py_str(other)),
        })
        .collect()
}

/// `extra.get(key)` as a text, when it is truthy.
fn text_of(extra: &Map<String, Value>, key: &str) -> Option<String> {
    extra.get(key).filter(|v| pyjson::truthy(v)).map(|v| match v {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    })
}

/// `_notify`: a schedule event: the notification centre's log (for the people the schedule names), and the
/// schedule's own feed. A run that needs input or fails is told by the run itself; a slot that ends is told here.
/// `extra` holds the keyword arguments of the Python call, in their order (`run_id`, `srun_id`, `action`, `skipped`).
pub fn notify(s: &ai_schedule::Model, event: &str, text: &str, extra: Map<String, Value>) {
    if !wants(s, event) {
        return;
    }
    let to = people(s);
    let skipped = extra.get("skipped").is_some_and(pyjson::truthy);
    let data = |event: &str| {
        let mut data = Map::new();
        data.insert("schedule_id".into(), json!(s.id));
        data.insert("event".into(), json!(event));
        data.insert("action".into(), extra.get("action").cloned().unwrap_or(Value::Null));
        data
    };
    if event == "started" {
        // design E4 "KAN-151 run started by schedule · Open run": a line for information, grouped when several
        // start
        enqueue(PendingEvent {
            kind: "schedule_started".to_string(),
            fields: EmitFields {
                project_id: Some(s.project_id.clone()),
                title: text.to_string(),
                target_kind: Some("run".to_string()),
                target_id: text_of(&extra, "run_id"),
                ticket_id: Some(s.ticket_id.clone()),
                member_id: Some(s.member_id.clone()),
                data: Some(data("started")),
                ..Default::default()
            },
            names: Some(names_of(&to)),
            follow_ticket: Some(s.ticket_id.clone()),
        });
    }
    if !matches!(event, "started" | "needs_input") {
        // a skipped slot is news, not work: it is told under the information kind, whichever switch let it through
        let needs = event == "failed" && !skipped;
        let srun_id = text_of(&extra, "srun_id");
        enqueue(PendingEvent {
            kind: if needs { "run_failed" } else { "schedule" }.to_string(),
            fields: EmitFields {
                project_id: Some(s.project_id.clone()),
                title: text.to_string(),
                body: Some(text_of(&extra, "note").unwrap_or_default()),
                target_kind: Some(if srun_id.is_some() { "schedule_run" } else { "run" }.to_string()),
                target_id: srun_id.or_else(|| text_of(&extra, "run_id")),
                ticket_id: Some(s.ticket_id.clone()),
                member_id: Some(s.member_id.clone()),
                data: Some(data(if skipped { "skipped" } else { event })),
                ..Default::default()
            },
            names: Some(names_of(&to)),
            follow_ticket: Some(s.ticket_id.clone()),
        });
    }
    let mut item = Map::new();
    item.insert("id".into(), json!(RT.next_seq()));
    item.insert("at".into(), json!(now_iso()));
    item.insert("project_id".into(), json!(s.project_id));
    item.insert("schedule_id".into(), json!(s.id));
    item.insert("ticket_id".into(), json!(s.ticket_id));
    item.insert("event".into(), json!(event));
    item.insert("text".into(), json!(text));
    item.insert("to".into(), Value::Array(to));
    for (key, value) in extra {
        item.insert(key, value);
    }
    let mut inner = RT.inner();
    if inner.events.len() >= EVENTS_KEPT {
        inner.events.pop_front();
    }
    inner.events.push_back(item);
}

/// Toasts for the UI (E4): the client keeps the last id it showed. (Python's default `after`: 0.)
pub fn events_since(project_id: &str, after: i64) -> Vec<Map<String, Value>> {
    RT.inner()
        .events
        .iter()
        .filter(|e| {
            e.get("project_id").and_then(Value::as_str) == Some(project_id)
                && e.get("id").and_then(Value::as_i64).is_some_and(|id| id > after)
        })
        .cloned()
        .collect()
}

/// `_activity`: one Activity entry on the ticket: "<actor> <text>". (`ai`: the AI attribution of the entry, if it
/// is one's.)
pub(crate) async fn activity(ticket_id: &str, text: &str, actor: &str, ai: Option<Value>) -> Result<(), DbErr> {
    let session = database::session();
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(&session).await? else { return Ok(()) };
    let mut log = ticket.activity_log.clone();
    let token = ai.filter(pyjson::truthy).map(|ai| activity::set_ai(Some(ai)));
    activity::record(&mut log, "ai_schedule", Value::Null, json!(text), None, Some(actor));
    if let Some(token) = token {
        ctx::reset(token);
    }
    let mut row = ticket.into_active_model();
    row.activity_log = Set(log);
    row.update(&session).await?;
    session.commit().await
}
