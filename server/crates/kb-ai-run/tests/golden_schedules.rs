//! `schedules` against what the Python module gave (`contract/golden/ai_schedules.json`, made by
//! `gen_ai_schedules.py`): the slots of every kind of schedule in time zones with and without summer time, across
//! both clock changes, month ends and a leap day; labels, deadlines and the other pure functions; and, on the rows
//! the Python models dumped and with the clock stopped where the generator stopped it, the checks of the editor,
//! previews, a schedule as the UI reads it, lists, history, the week, the cards, creating and changing schedules step
//! by step, and the loop one `tick(now)` at a time through every story the generator wrote (the runs a slot starts
//! stay queued: no CLI is started, a story moves a run on by changing its row). After every step the schedules, the
//! slots, the runs, the tickets' Activity, the schedule's feed and the notifications are the ones Python had.

mod common;

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use kb_ai_run::{clock, schedules};
use kb_db::database;
use kb_db::entities::{ai_run, ai_schedule, ai_schedule_run, ai_team, member, notify_event, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    common::golden("ai_schedules.json")
}

fn cases(g: &Value, name: &str) -> Vec<Value> {
    let cases = g[name].as_array().unwrap_or_else(|| panic!("{name}")).clone();
    assert!(!cases.is_empty(), "{name}");
    cases
}

fn at(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text).unwrap_or_else(|e| panic!("{text}: {e}")).to_utc()
}

fn now_of(g: &Value) -> DateTime<Utc> {
    at(g["now"].as_str().expect("now"))
}

fn keys(map: &Map<String, Value>) -> Value {
    json!(map.keys().collect::<Vec<_>>())
}

/// Every number as a float: a Python object keeps the int it was given for a float column, the model does not.
fn loose(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64()),
        Value::Array(items) => Value::Array(items.iter().map(loose).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), loose(v))).collect()),
        other => other.clone(),
    }
}

/// What a call gave, as the generator wrote it: `{"ok": value}`, `{"error": [code, message, extra]}` for a
/// `ScheduleError`, `{"raises": ...}` for anything else.
fn outcome<T: serde::Serialize>(result: Result<T, schedules::Error>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(schedules::Error::Schedule(err)) => json!({"error": [err.code, err.message, err.extra]}),
        Err(other) => json!({"raises": other.to_string()}),
    }
}

/// `got` against `want`; where Python raised something that is no `ScheduleError`, only that Rust failed too.
fn same(got: &Value, want: &Value, what: &str) {
    if want.get("raises").is_some() {
        assert!(got.get("raises").is_some(), "{what}: Python raised {}, Rust gave {got}", want["raises"]);
    } else {
        assert_eq!(got, want, "{what}");
    }
}

/// The schedule `AiSchedule(**{**BASE, **kw})` of a pure case.
fn sched(base: &Value, kw: &Value) -> ai_schedule::Model {
    let mut row = base.as_object().expect("the base").clone();
    for (key, value) in kw.as_object().expect("the fields") {
        row.insert(key.clone(), value.clone());
    }
    serde_json::from_value(Value::Object(row)).unwrap_or_else(|e| panic!("a schedule: {e}: {kw}"))
}

fn iso_list(times: Vec<DateTime<Utc>>) -> Vec<String> {
    times.iter().map(kb_base::time::iso).collect()
}

#[test]
fn zones_times_and_words() {
    let g = golden();
    let p = &g["pure"];
    let now = now_of(&g);
    for case in cases(p, "zone") {
        let got = outcome(schedules::zone(case["name"].as_str()).map(|tz| tz.name().to_string()));
        same(&got, &case["out"], &format!("zone {}", case["name"]));
    }
    for case in cases(p, "hm") {
        let got = outcome(schedules::hm(case["value"].as_str()).map(|(h, m)| json!([h, m])));
        same(&got, &case["out"], &format!("hm {}", case["value"]));
    }
    for case in cases(p, "tz_label") {
        let (name, when) = (case["name"].as_str().expect("name"), at(case["at"].as_str().expect("at")));
        same(&outcome(schedules::tz_label(name, Some(when))), &case["out"], &format!("tz_label {name} {when}"));
    }
    for case in cases(p, "in_words") {
        let when = at(case["at"].as_str().expect("at"));
        assert_eq!(json!(schedules::in_words(when, Some(now))), case["out"], "{case}");
    }
    let c = &p["constants"];
    assert_eq!(json!(schedules::DAY_NAMES), c["DAY_NAMES"]);
    assert_eq!(Value::Object(schedules::default_limits()), c["DEFAULT_LIMITS"]);
    assert_eq!(keys(&schedules::default_limits()), keys(c["DEFAULT_LIMITS"].as_object().expect("limits")));
    assert_eq!(json!(schedules::NOTIFY_EVENTS), c["NOTIFY_EVENTS"]);
    assert_eq!(json!(schedules::OPEN), c["OPEN"]);
    assert_eq!(json!(schedules::ENDED), c["ENDED"]);
    assert_eq!(Some(schedules::LATE_AFTER_S), c["LATE_AFTER_S"].as_f64());
    assert_eq!(json!(schedules::BUSY_MAX_WAIT_MIN), c["BUSY_MAX_WAIT_MIN"]);
    assert_eq!(json!(schedules::AUTO_PAUSE_AFTER), c["AUTO_PAUSE_AFTER"]);
    assert_eq!(Some(schedules::TICK_S), c["TICK_S"].as_f64());
    assert_eq!(Some(schedules::tick_s()), c["TICK_S"].as_f64());
    assert_eq!(json!(schedules::FIELDS), c["FIELDS"]);
    assert_eq!(json!(schedules::JSON_FIELDS), c["JSON_FIELDS"]);
}

#[test]
fn the_slots_of_every_kind_of_schedule() {
    let g = golden();
    let p = &g["pure"];
    let slots = cases(p, "slots");
    assert!(slots.len() > 600);
    for case in slots {
        let s = sched(&p["base"], &case["s"]);
        let after = at(case["after"].as_str().expect("after"));
        let n = case["n"].as_u64().expect("n") as usize;
        let got = outcome(schedules::slots(&s, after, n).map(iso_list));
        same(&got, &case["out"], &format!("slots of {} after {after} ({n})", case["s"]));
    }
    for case in cases(p, "advance") {
        let mut s = sched(&p["base"], &case["s"]);
        let got = outcome(schedules::advance(&mut s, at(case["after"].as_str().expect("after")), case["end"] == true));
        same(&got, &case["out"], &format!("advance {}", case["s"]));
        assert_eq!(json!(s.next_run_at), case["next_run_at"], "advance {}", case["s"]);
        assert_eq!(json!(s.state), case["state"], "advance {}", case["s"]);
    }
    for case in cases(p, "when_label") {
        let s = sched(&p["base"], &case["s"]);
        same(&outcome(schedules::when_label(&s)), &case["out"], &format!("when_label {}", case["s"]));
    }
    for case in cases(p, "fmt_day") {
        let got = outcome(schedules::fmt_day(at(case["at"].as_str().expect("at")), case["tz"].as_str().expect("tz")));
        same(&got, &case["out"], &format!("fmt_day {case}"));
    }
    for case in cases(p, "deadline") {
        let s = sched(&p["base"], &case["s"]);
        let slot = at(case["slot"].as_str().expect("slot"));
        let got = outcome(schedules::deadline(&s, slot).map(|d| kb_base::time::iso(&d)));
        same(&got, &case["out"], &format!("deadline of {} for {slot}", case["s"]));
    }
}

#[test]
fn what_a_schedule_says_and_keeps() {
    let g = golden();
    let p = &g["pure"];
    for case in cases(p, "instruction") {
        let s = sched(&p["base"], &case["s"]);
        assert_eq!(json!(schedules::instruction(&s, case["extra"].as_str().expect("extra"))), case["out"], "{case}");
    }
    for case in cases(p, "limits_of") {
        let s = sched(&p["base"], &json!({"limits": case["limits"]}));
        let got = schedules::limits_of(&s);
        assert_eq!(keys(&got), case["keys"], "{case}");
        assert_eq!(Value::Object(got), case["out"], "{case}");
    }
    for case in cases(p, "short") {
        let got =
            schedules::short(case["text"].as_str().expect("text"), case["limit"].as_u64().expect("limit") as usize);
        assert_eq!(json!(got), case["out"], "{case}");
    }
    for case in cases(p, "run_to_dict") {
        let row: ai_schedule_run::Model = serde_json::from_value(case["row"].clone()).expect("a slot");
        let names: Option<HashMap<String, String>> = case["names"]
            .as_object()
            .map(|names| names.iter().map(|(k, v)| (k.clone(), v.as_str().expect("a name").to_string())).collect());
        let got = schedules::run_to_dict(&row, names.as_ref());
        assert_eq!(keys(&got), case["keys"]);
        assert_eq!(Value::Object(got), case["out"], "{} with {}", case["row"]["id"], case["names"]);
    }
    for case in cases(p, "report_of") {
        let run: Option<ai_run::Model> =
            (!case["run"].is_null()).then(|| serde_json::from_value(case["run"].clone()).expect("a run"));
        assert_eq!(json!(schedules::report_of(run.as_ref())), case["out"], "{}", case["run"]["id"]);
    }
    for case in cases(p, "apply") {
        let mut s = sched(&p["base"], &json!({}));
        let nulls = schedules::apply(&mut s, case["data"].as_object().expect("data")).expect("apply");
        assert!(nulls.is_empty(), "{}", case["data"]);
        assert_eq!(loose(&json!(s)), loose(&case["out"]), "apply {}", case["data"]);
    }
}

/// `AiSchedule(project_id=project, ticket_id="", member_id="", created_by=by, id=id)`.
fn blank(project_id: &str, by: &str, id: &str) -> ai_schedule::Model {
    use kb_db::sea_orm::TryIntoModel;
    let mut s = ai_schedule::new();
    s.id = Set(id.to_string());
    s.project_id = Set(project_id.to_string());
    s.ticket_id = Set(String::new());
    s.member_id = Set(String::new());
    s.created_by = Set(by.to_string());
    s.try_into_model().expect("every column has a value")
}

fn maps(list: Vec<Map<String, Value>>) -> Value {
    Value::Array(list.into_iter().map(Value::Object).collect())
}

#[tokio::test]
async fn the_schedules_of_a_project_as_the_editor_and_the_lists_read_them() {
    let _guard = common::init().await;
    let g = golden();
    let now = now_of(&g);
    clock::set_now(Some(now));
    let b = &g["board"];
    common::insert_all(&b["rows"]).await;
    const P: &str = "p-sch";
    let session = database::session();
    for (zone, label) in g["pure"]["tz_label_now"].as_object().expect("zones") {
        assert_eq!(&json!(schedules::tz_label(zone, None).expect("a zone")), label, "{zone}");
    }
    for (when, words) in g["pure"]["in_words_now"].as_object().expect("times") {
        assert_eq!(&json!(schedules::in_words(at(when), None)), words, "{when}");
    }
    for case in cases(b, "role_of") {
        let got = schedules::role_of(
            &session,
            case["project_id"].as_str().expect("project"),
            case["person"].as_str().expect("person"),
        )
        .await
        .expect("role_of");
        assert_eq!(json!(got), case["out"], "{case}");
    }
    for case in cases(b, "availability") {
        let project = case["project_id"].as_str().expect("project");
        let (ok, why) =
            schedules::availability(&session, case["member_id"].as_str(), project).await.expect("availability");
        assert_eq!(json!([ok, why]), case["out"], "{} in {project}", case["member_id"]);
    }
    for case in cases(b, "assess") {
        let by = case["by"].as_str().expect("by");
        let mut s = blank(P, by, "sch_new");
        let got = match schedules::apply(&mut s, case["data"].as_object().expect("data")) {
            Ok(nulls) => outcome(schedules::assess_with(&session, &s, by, Some(now), &nulls).await),
            Err(err) => outcome::<Value>(Err(err)),
        };
        same(&got, &case["out"], &format!("assess by {by} of {}", case["data"]));
    }
    // (the schedules of this test's rows: the tests of this file share one database)
    let own: Vec<&str> =
        b["rows"]["ai_schedule"].as_array().expect("rows").iter().filter_map(|r| r["id"].as_str()).collect();
    let stored = ai_schedule::Entity::find()
        .filter(ai_schedule::Column::Id.is_in(own))
        .order_by_asc(ai_schedule::Column::Id)
        .all(&session)
        .await
        .expect("schedules");
    let by_id: HashMap<&str, &ai_schedule::Model> = stored.iter().map(|s| (s.id.as_str(), s)).collect();
    for case in cases(b, "assess_stored") {
        let s = by_id[case["id"].as_str().expect("id")];
        same(
            &outcome(schedules::assess(&session, s, &s.created_by, None).await),
            &case["out"],
            &format!("assess of {}", s.id),
        );
    }
    for case in cases(b, "preview") {
        let got = schedules::preview(
            &session,
            P,
            case["data"].as_object().expect("data"),
            case["by"].as_str().expect("by"),
            case["schedule_id"].as_str(),
        )
        .await;
        same(
            &outcome(got),
            &case["out"],
            &format!("preview by {} of {} with {}", case["by"], case["schedule_id"], case["data"]),
        );
    }
    for case in cases(b, "summary_text") {
        let s = by_id[case["id"].as_str().expect("id")];
        same(&outcome(schedules::summary_text(&session, s).await), &case["out"], &format!("summary of {}", s.id));
    }
    for case in cases(b, "to_dict") {
        let s = by_id[case["id"].as_str().expect("id")];
        let got = schedules::to_dict(&session, s, None).await.expect("to_dict");
        assert_eq!(keys(&got), case["keys"], "{}", s.id);
        for (key, value) in &got {
            assert_eq!(value, &case["out"][key], "{}: {key}", s.id);
        }
    }
    let last = ai_schedule_run::Entity::find_by_id("sl_03").one(&session).await.expect("db").expect("the slot");
    let got = schedules::to_dict(&session, &stored[0], Some(&last)).await.expect("to_dict");
    assert_eq!(Value::Object(got), b["to_dict_last"]);
    for case in cases(b, "list_for") {
        let project = case["project_id"].as_str().expect("project");
        let got = schedules::list_for(&session, project, case["ticket_id"].as_str()).await.expect("list_for");
        let ids =
            |list: &Value| list["items"].as_array().expect("items").iter().map(|i| i["id"].clone()).collect::<Vec<_>>();
        assert_eq!(ids(&Value::Object(got.clone())), ids(&case["out"]), "{project} {}: the order", case["ticket_id"]);
        assert_eq!(Value::Object(got), case["out"], "{project} {}", case["ticket_id"]);
    }
    for case in cases(b, "history") {
        let got = schedules::history(
            &session,
            case["project_id"].as_str().expect("project"),
            case["schedule_id"].as_str(),
            case["limit"].as_u64().expect("limit"),
        )
        .await
        .expect("history");
        assert_eq!(maps(got), case["out"], "history {} {} {}", case["project_id"], case["schedule_id"], case["limit"]);
    }
    for case in cases(b, "detail") {
        let id = case["id"].as_str().expect("id");
        let got = schedules::detail(&session, id).await;
        if let Ok(got) = &got {
            assert_eq!(keys(got), case["keys"], "{id}");
            for (key, value) in got {
                assert_eq!(value, &case["out"]["ok"][key], "detail of {id}: {key}");
            }
        }
        same(&outcome(got), &case["out"], &format!("detail of {id}"));
    }
    for case in cases(b, "week") {
        let project = case["project_id"].as_str().expect("project");
        let start = at(case["start"].as_str().expect("start"));
        let mut got =
            schedules::week(&session, project, start, case["days"].as_i64().expect("days")).await.expect("week");
        // (Python lists the members in the order of a set; the generator sorted them)
        if let Some(Value::Array(members)) = got.get_mut("members") {
            members.sort_by_key(|m| m["id"].as_str().unwrap_or("").to_string());
        }
        let what = format!("week of {project} from {start} for {}", case["days"]);
        assert_eq!(got["items"].as_array().map(Vec::len), case["out"]["items"].as_array().map(Vec::len), "{what}");
        for (got, want) in
            got["items"].as_array().expect("items").iter().zip(case["out"]["items"].as_array().expect("items"))
        {
            assert_eq!(got, want, "{what}");
        }
        assert_eq!(Value::Object(got), case["out"], "{what}");
    }
    for (project, want) in b["for_tickets"].as_object().expect("projects") {
        let got = schedules::for_tickets(&session, project).await.expect("for_tickets");
        assert_eq!(keys(&got), keys(want.as_object().expect("cards")), "{project}");
        assert_eq!(&Value::Object(got), want, "{project}");
    }
    clock::set_now(None);
}

// ---------------------------------------------------------------------------------------------------------------
// what the editing steps and the stories look at after each step
// ---------------------------------------------------------------------------------------------------------------

/// What was already looked at: the last id of the schedule's feed and of the notification log.
#[derive(Default)]
struct Seen {
    events: i64,
    notes: i32,
}

async fn last_note() -> i32 {
    let session = database::session();
    let last = notify_event::Entity::find().order_by_desc(notify_event::Column::Id).one(&session).await.expect("db");
    last.map_or(0, |n| n.id)
}

/// A value with the ids of runs and slots replaced by their names (`TICKET#number`, `schedule@slot`).
fn named(value: &Value, names: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => json!(names.get(s).unwrap_or(s)),
        Value::Array(items) => Value::Array(items.iter().map(|v| named(v, names)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), named(v, names))).collect()),
        other => other.clone(),
    }
}

fn parsed(text: &str, default: Value) -> Value {
    if text.is_empty() { default } else { serde_json::from_str(text).expect("JSON in a column") }
}

/// The generator's `snapshot(project_id)`: the schedules, slots and runs of a project, the Activity its tickets got
/// from schedules, and what was told since the last look.
async fn snapshot(project_id: &str, seen: &mut Seen) -> Value {
    kb_notify::flush_pending().await.expect("the notifications are written");
    let session = database::session();
    let scheds = ai_schedule::Entity::find()
        .filter(ai_schedule::Column::ProjectId.eq(project_id))
        .order_by_asc(ai_schedule::Column::Id)
        .all(&session)
        .await
        .expect("schedules");
    let slots = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::ProjectId.eq(project_id))
        .order_by_asc(ai_schedule_run::Column::ScheduleId)
        .order_by_asc(ai_schedule_run::Column::SlotAt)
        .all(&session)
        .await
        .expect("slots");
    let runs = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .order_by_asc(ai_run::Column::TicketId)
        .order_by_asc(ai_run::Column::Number)
        .all(&session)
        .await
        .expect("runs");
    let tickets = ticket::Entity::find()
        .filter(ticket::Column::ProjectId.eq(project_id))
        .order_by_asc(ticket::Column::Id)
        .all(&session)
        .await
        .expect("tickets");
    let notes = notify_event::Entity::find()
        .filter(notify_event::Column::ProjectId.eq(project_id))
        .filter(notify_event::Column::Id.gt(seen.notes))
        .order_by_asc(notify_event::Column::Id)
        .all(&session)
        .await
        .expect("notifications");
    let mut names: HashMap<String, String> = HashMap::new();
    for r in &runs {
        names.insert(r.id.clone(), format!("{}#{}", r.ticket_id.as_deref().unwrap_or("None"), r.number));
    }
    for s in &slots {
        names.insert(s.id.clone(), format!("{}@{}", s.schedule_id, s.slot_at));
    }
    let feed = schedules::events_since(project_id, seen.events);
    if let Some(last) = feed.last() {
        seen.events = last["id"].as_i64().expect("an id");
    }
    if let Some(last) = notes.last() {
        seen.notes = last.id;
    }
    let activity: Map<String, Value> = tickets
        .iter()
        .map(|t| {
            let entries: Vec<Value> = parsed(&t.activity_log, json!([]))
                .as_array()
                .expect("a log")
                .iter()
                .filter(|e| e["field"] == "ai_schedule")
                .map(|e| json!({"actor": e["actor"], "to": e["to"]}))
                .collect();
            (t.id.clone(), json!(entries))
        })
        .collect();
    json!({
        "schedules": scheds.iter().map(|s| json!({
            "id": s.id, "state": s.state, "paused_reason": s.paused_reason, "failures_in_row": s.failures_in_row,
            "runs_count": s.runs_count, "next_run_at": s.next_run_at, "ticket_seen_at": s.ticket_seen_at,
        })).collect::<Vec<_>>(),
        "slots": slots.iter().map(|r| json!({
            "slot": names[&r.id], "state": r.state, "catch_up": r.catch_up, "member_id": r.member_id,
            "runs": named(&parsed(&r.run_ids, json!([])), &names), "attempts": r.attempts, "note": r.note,
            "started": r.started_at.is_some(), "ended": r.ended_at.is_some(), "cost_usd": r.cost_usd,
        })).collect::<Vec<_>>(),
        "runs": runs.iter().map(|r| json!({
            "run": names[&r.id], "member_id": r.member_id, "state": r.state, "kind": r.kind, "trigger": r.trigger,
            "started_by": r.started_by, "instruction": r.instruction, "session_id": r.session_id,
            "ended_by": r.ended_by, "ended_reason": r.ended_reason, "stop_code": r.stop_code,
        })).collect::<Vec<_>>(),
        "activity": activity,
        "feed": feed.iter().map(|e| {
            let mut e = e.clone();
            e.shift_remove("id");
            e.shift_remove("at");
            named(&Value::Object(e), &names)
        }).collect::<Vec<_>>(),
        "notifications": notes.iter().map(|n| json!({
            "kind": n.kind, "needs": n.needs, "title": n.title, "body": n.body, "target_kind": n.target_kind,
            "target_id": named(&json!(n.target_id), &names), "ticket_id": n.ticket_id, "member_id": n.member_id,
            "data": named(&parsed(&n.data, json!({})), &names), "recipients": parsed(&n.recipients, json!([])),
        })).collect::<Vec<_>>(),
    })
}

/// The id of a run that is gone (a story deleted it) has no name: `<run>` on both sides.
fn without_lost_runs(value: &Value) -> Value {
    match value {
        Value::String(s) if s.len() == 16 && s.starts_with("run_") => json!("<run>"),
        Value::Array(items) => Value::Array(items.iter().map(without_lost_runs).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), without_lost_runs(v))).collect()),
        other => other.clone(),
    }
}

/// Both snapshots, part by part, so that a difference names its part. Schedules and slots are compared in the order
/// of their names (the generator ordered them by ids that are new at every run).
fn same_after(got: &Value, want: &Value, what: &str) {
    let (got, want) = (without_lost_runs(got), without_lost_runs(want));
    for part in ["schedules", "slots", "runs", "activity", "feed", "notifications"] {
        if let (Some(got), Some(want)) = (got[part].as_array(), want[part].as_array()) {
            assert_eq!(got.len(), want.len(), "{what}: how many {part}\n got: {got:#?}\nwant: {want:#?}");
            let (mut got, mut want) = (got.clone(), want.clone());
            let name = |row: &Value| row["id"].as_str().or(row["slot"].as_str()).unwrap_or("").to_string();
            if matches!(part, "schedules" | "slots") {
                got.sort_by_key(name);
                want.sort_by_key(name);
            }
            for (got, want) in got.iter().zip(&want) {
                assert_eq!(loose(got), loose(want), "{what}: {part}");
            }
        } else {
            assert_eq!(got[part], want[part], "{what}: {part}");
        }
    }
}

/// A text of this run in place of every id a step made (`made:<n>`), in a value of either side.
fn with_made(value: &Value, made: &[String]) -> Value {
    let mut text = serde_json::to_string(value).expect("json");
    for (i, id) in made.iter().enumerate() {
        text = text.replace(id.as_str(), &format!("made:{i}"));
    }
    serde_json::from_str(&text).expect("json")
}

/// A stored schedule as the generator dumped it, without what is new at every run.
fn stored_schedule(row: &Value) -> Value {
    let mut row = row.as_object().expect("a schedule").clone();
    for key in ["created_at", "updated_at"] {
        row.insert(key.into(), json!("<time>"));
    }
    loose(&Value::Object(row))
}

#[tokio::test]
async fn creating_changing_pausing_and_deleting_schedules() {
    let _guard = common::init().await;
    let g = golden();
    clock::set_now(Some(now_of(&g)));
    let e = &g["editing"];
    common::insert_all(&e["rows"]).await;
    const PE: &str = "p-edit-sch";
    schedules::RT.reset();
    let mut seen = Seen { events: 0, notes: last_note().await };
    snapshot(PE, &mut seen).await;
    let (mut made, mut py_made): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for step in cases(e, "steps") {
        let call = step["call"].as_str().expect("call");
        let by = step["by"].as_str().unwrap_or("");
        let id = match &step["id"] {
            Value::Number(n) => made[n.as_u64().expect("an index") as usize].clone(),
            other => other.as_str().unwrap_or("").to_string(),
        };
        let session = database::session();
        let data = step["data"].as_object().cloned().unwrap_or_default();
        let got = match call {
            "create" => {
                let got = schedules::create(&session, PE, &data, by).await;
                if let Ok(s) = &got {
                    made.push(s.id.clone());
                    py_made.push(step["out"]["ok"]["id"].as_str().expect("Python made it too").to_string());
                }
                outcome(got)
            }
            "update" => outcome(schedules::update(&session, &id, &data, by).await),
            "set_paused" => {
                outcome(schedules::set_paused(&session, &id, step["paused"] == true, by, step["reason"].as_str()).await)
            }
            "delete" => outcome(schedules::delete(&session, &id, by).await.map(|()| Value::Null)),
            "get_or_404" => outcome(schedules::get_or_404(&session, &id).await),
            _ => {
                // the story's own hand: the schedule has ended
                let s = ai_schedule::Entity::find_by_id(id.as_str()).one(&session).await.expect("db").expect("made");
                let mut row = s.into_active_model();
                row.state = Set("ended".into());
                row.next_run_at = Set(None);
                row.update(&session).await.expect("update");
                session.commit().await.expect("commit");
                json!({"ok": null})
            }
        };
        drop(session);
        let what = format!("{call} {} by {by} with {}", step["id"], step["data"]);
        let (got, want) = (with_made(&got, &made), with_made(&step["out"], &py_made));
        match (got.get("ok").filter(|ok| ok.is_object()), want.get("ok").filter(|ok| ok.is_object())) {
            (Some(got), Some(want)) => {
                for (key, value) in stored_schedule(want).as_object().expect("a schedule") {
                    assert_eq!(&stored_schedule(got)[key], value, "{what}: {key}");
                }
            }
            _ => same(&got, &want, &what),
        }
        let after = snapshot(PE, &mut seen).await;
        same_after(&with_made(&after, &made), &with_made(&step["after"], &py_made), &what);
    }
    clock::set_now(None);
}

fn run_field(row: &mut ai_run::ActiveModel, key: &str, value: &Value) {
    assert!(kb_ai::store::set_run_field(row, key, value), "a run has no column {key}");
}

async fn run_named(project_id: &str, name: &str) -> Option<ai_run::Model> {
    let session = database::session();
    let runs =
        ai_run::Entity::find().filter(ai_run::Column::ProjectId.eq(project_id)).all(&session).await.expect("runs");
    runs.into_iter().find(|r| format!("{}#{}", r.ticket_id.as_deref().unwrap_or("None"), r.number) == name)
}

async fn slot_named(project_id: &str, name: &str) -> Option<ai_schedule_run::Model> {
    let session = database::session();
    let slots = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::ProjectId.eq(project_id))
        .all(&session)
        .await
        .expect("slots");
    slots.into_iter().find(|s| format!("{}@{}", s.schedule_id, s.slot_at) == name)
}

/// One step of a story, as the generator did it. None: the step only changed rows.
async fn play(project_id: &str, step: &Value) -> Option<Value> {
    let by = step["by"].as_str().unwrap_or("");
    let fields = step["set"].as_object().cloned().unwrap_or_default();
    match step["op"].as_str().expect("op") {
        "tick" => {
            let now = at(step["now"].as_str().expect("now"));
            clock::set_now(Some(now));
            Some(outcome(schedules::tick(Some(now)).await.map(|()| Value::Null)))
        }
        "run" => {
            // (a run the story names that was never made: Python's step fails on its own lookup)
            let Some(run) = run_named(project_id, step["run"].as_str().expect("run")).await else {
                return Some(json!({"raises": "KeyError"}));
            };
            let session = database::session();
            let mut row = run.into_active_model();
            for (key, value) in &fields {
                run_field(&mut row, key, value);
            }
            row.update(&session).await.expect("update");
            session.commit().await.expect("commit");
            None
        }
        "lose_run" => {
            let run = run_named(project_id, step["run"].as_str().expect("run")).await.expect("the run");
            let session = database::session();
            run.delete(&session).await.expect("delete");
            session.commit().await.expect("commit");
            None
        }
        "team" => {
            let session = database::session();
            let id = step["id"].as_str().expect("id");
            let team = ai_team::Entity::find_by_id(id).one(&session).await.expect("db").expect("the team");
            let mut row = team.into_active_model();
            for (key, value) in &fields {
                match key.as_str() {
                    "paused" => row.paused = Set(value.as_bool().expect("a bool")),
                    "health" => row.health = Set(value.as_str().expect("a text").to_string()),
                    other => panic!("no step sets {other} of a team"),
                }
            }
            row.update(&session).await.expect("update");
            session.commit().await.expect("commit");
            None
        }
        "member" => {
            let session = database::session();
            let id = step["id"].as_str().expect("id");
            let who = member::Entity::find_by_id(id).one(&session).await.expect("db").expect("the member");
            let mut row = who.into_active_model();
            for (key, value) in &fields {
                match key.as_str() {
                    "role" => row.role = Set(value.as_str().expect("a text").to_string()),
                    "kind" => row.kind = Set(value.as_str().expect("a text").to_string()),
                    other => panic!("no step sets {other} of a member"),
                }
            }
            row.update(&session).await.expect("update");
            session.commit().await.expect("commit");
            None
        }
        "ticket" => {
            let session = database::session();
            let id = step["id"].as_str().expect("id");
            let t = ticket::Entity::find_by_id(id).one(&session).await.expect("db").expect("the ticket");
            let mut row = t.into_active_model();
            row.status = Set(fields["status"].as_str().expect("a status").to_string());
            row.update(&session).await.expect("update");
            session.commit().await.expect("commit");
            None
        }
        "set_paused" => {
            let session = database::session();
            let id = step["id"].as_str().expect("id");
            Some(outcome(schedules::set_paused(&session, id, step["paused"] == true, by, None).await.map(|s| s.state)))
        }
        "run_now" => {
            let session = database::session();
            Some(outcome(schedules::run_now(&session, step["id"].as_str().expect("id"), by).await.map(|s| s.state)))
        }
        "slot_action" => {
            let name = step["slot"].as_str().expect("slot");
            let id = slot_named(project_id, name).await.map_or_else(|| name.to_string(), |s| s.id);
            let session = database::session();
            let done = schedules::slot_action(
                &session,
                &id,
                step["action"].as_str().expect("action"),
                by,
                step["member_id"].as_str(),
            )
            .await;
            Some(outcome(done.map(|s| s.state)))
        }
        other => panic!("no step {other}"),
    }
}

#[tokio::test]
async fn the_loop_one_tick_at_a_time() {
    let _guard = common::init().await;
    let g = golden();
    let stories = cases(&g, "stories");
    assert!(stories.len() >= 30);
    let mut seen = Seen { events: 0, notes: last_note().await };
    for story in stories {
        let key = story["key"].as_str().expect("key");
        let project_id = story["project_id"].as_str().expect("project");
        // the loop looks at every schedule and slot there is: each story starts with none but its own
        common::clear::<ai_schedule::Entity>().await;
        common::clear::<ai_schedule_run::Entity>().await;
        common::clear::<ai_run::Entity>().await;
        schedules::RT.reset();
        seen.events = 0;
        common::insert_all(&story["rows"]).await;
        clock::set_now(Some(now_of(&g)));
        snapshot(project_id, &mut seen).await;
        for (i, step) in story["steps"].as_array().expect("steps").iter().enumerate() {
            let mut told = step.clone();
            told.as_object_mut().expect("a step").shift_remove("after");
            let what = format!("{key} ({}), step {i}: {told}", story["title"]);
            let got = play(project_id, step).await.unwrap_or(Value::Null);
            same(&got, &step["out"], &what);
            let after = snapshot(project_id, &mut seen).await;
            same_after(&after, &step["after"], &what);
        }
    }
    clock::set_now(None);
}
