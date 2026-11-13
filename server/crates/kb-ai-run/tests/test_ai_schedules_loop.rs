//! The schedule loop running for real: `schedules::start_scheduler()` with the runs' scheduler and the stand-in CLI
//! (mode v2), against what the Python server recorded for the same four schedules
//! (`contract/golden/ai_schedule_loop.json`, made by `gen_ai_schedule_loop.py`): a schedule that is due starts its
//! run and its slot passes with what the lead reported; one that was missed by ten minutes starts as a catch-up; one
//! missed for longer than its catch-up time is skipped and people are told; a one-off ends with its slot.
//!
//! Also here: `test_a_schedule_dry_run_is_a_plan_from_the_assistant` of `tests/test_board_ai_v2.py`, at service level
//! (the route `POST /projects/{id}/ai/schedules/dry-run` is ported with `api/schedules.py`; the assistant is the
//! seam `seams::Assistant`, which `kb-assist` fills).

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{Duration, Utc};
use common::runs_env::Env;
use kb_ai_run::schedules;
use kb_ai_run::seams::{self, AssistAsk, AssistFailure, AssistTurn};
use kb_db::database;
use kb_db::entities::{ai_run, ai_schedule, ai_schedule_run, notify_event, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

async fn a_ticket(project_id: &str, id: &str, title: &str) {
    let session = database::session();
    let mut row = ticket::new();
    row.id = Set(id.to_string());
    row.project_id = Set(project_id.to_string());
    row.title = Set(title.to_string());
    row.status = Set("todo".to_string());
    row.insert(&session).await.expect("ticket");
    session.commit().await.expect("commit");
}

async fn a_schedule(
    project_id: &str,
    id: &str,
    ticket_id: &str,
    member_id: &str,
    edit: impl FnOnce(&mut ai_schedule::ActiveModel),
) {
    let session = database::session();
    let mut row = ai_schedule::new();
    row.id = Set(id.to_string());
    row.project_id = Set(project_id.to_string());
    row.ticket_id = Set(ticket_id.to_string());
    row.member_id = Set(member_id.to_string());
    row.created_by = Set("An Nguyen".to_string());
    row.days = Set("[0, 1, 2, 3, 4, 5, 6]".to_string());
    row.time = Set("00:00".to_string());
    edit(&mut row);
    row.insert(&session).await.expect("schedule");
    session.commit().await.expect("commit");
}

/// A value with ids replaced by names.
fn named(value: &Value, names: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => json!(names.get(s).unwrap_or(s)),
        Value::Array(items) => Value::Array(items.iter().map(|v| named(v, names)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), named(v, names))).collect()),
        other => other.clone(),
    }
}

/// A note without the clock time of this run: `HH:MM` for every time of day in it.
fn clock_free(note: Option<&str>) -> Value {
    let Some(note) = note else { return Value::Null };
    let chars: Vec<char> = note.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let is_time = i + 5 <= chars.len()
            && chars[i].is_ascii_digit()
            && chars[i + 1].is_ascii_digit()
            && chars[i + 2] == ':'
            && chars[i + 3].is_ascii_digit()
            && chars[i + 4].is_ascii_digit();
        if is_time {
            out.push_str("HH:MM");
            i += 5;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    json!(out)
}

fn parsed(text: &str, default: Value) -> Value {
    if text.is_empty() { default } else { serde_json::from_str(text).expect("JSON in a column") }
}

/// The generator's `snapshot`: what the loop left, with ids replaced by names.
async fn snapshot(project_id: &str, team_names: &HashMap<String, String>) -> Value {
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
        .order_by_asc(notify_event::Column::Id)
        .all(&session)
        .await
        .expect("notifications");
    let mut names = team_names.clone();
    for r in &runs {
        names.insert(r.id.clone(), format!("{}#{}", r.ticket_id.as_deref().unwrap_or("None"), r.number));
    }
    for s in &slots {
        names.insert(s.id.clone(), format!("slot of {}", s.schedule_id));
    }
    let mut feed: Vec<Value> = schedules::events_since(project_id, 0)
        .into_iter()
        .map(|mut e| {
            for key in ["id", "at", "project_id"] {
                e.shift_remove(key);
            }
            named(&Value::Object(e), &names)
        })
        .collect();
    let text = |v: &Value, key: &str| v[key].as_str().unwrap_or("").to_string();
    feed.sort_by_key(|e| (text(e, "schedule_id"), text(e, "event"), text(e, "text")));
    let mut told: Vec<Value> = notes
        .iter()
        .filter(|n| matches!(n.kind.as_str(), "schedule" | "schedule_started" | "run_failed"))
        .map(|n| {
            let data: Map<String, Value> = parsed(&n.data, json!({}))
                .as_object()
                .expect("data")
                .iter()
                .filter(|(k, _)| matches!(k.as_str(), "schedule_id" | "event" | "action" | "srun_id"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            json!({
                "kind": n.kind, "needs": n.needs, "title": n.title, "target_kind": n.target_kind,
                "target_id": named(&json!(n.target_id), &names), "ticket_id": n.ticket_id,
                "member": named(&json!(n.member_id), &names), "data": named(&Value::Object(data), &names),
                "recipients": parsed(&n.recipients, json!([])),
            })
        })
        .collect();
    told.sort_by_key(|n| (text(n, "kind"), text(n, "title")));
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
            "runs_count": s.runs_count, "has_next": s.next_run_at.is_some(), "saw_the_ticket": s.ticket_seen_at.is_some(),
        })).collect::<Vec<_>>(),
        "slots": slots.iter().map(|r| json!({
            "schedule_id": r.schedule_id, "state": r.state, "catch_up": r.catch_up,
            "member": named(&json!(r.member_id), &names), "runs": named(&parsed(&r.run_ids, json!([])), &names),
            "attempts": r.attempts, "note": clock_free(r.note.as_deref()), "started": r.started_at.is_some(),
            "ended": r.ended_at.is_some(), "cost_usd": r.cost_usd,
        })).collect::<Vec<_>>(),
        "runs": runs.iter().map(|r| json!({
            "run": names[&r.id], "member": named(&json!(r.member_id), &names), "state": r.state, "kind": r.kind,
            "trigger": r.trigger, "started_by": r.started_by, "instruction": r.instruction, "ended_by": r.ended_by,
            "report_status": parsed(&r.report, json!({}))["status"], "summary": r.summary,
        })).collect::<Vec<_>>(),
        "activity": activity,
        "feed": feed,
        "notifications": told,
    })
}

#[tokio::test]
async fn the_loop_starts_what_is_due_and_handles_what_was_missed_as_python_does() {
    let _guard = common::init().await;
    let want = common::golden("ai_schedule_loop.json");
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    common::clear::<ai_schedule::Entity>().await;
    common::clear::<ai_schedule_run::Entity>().await;
    let (pid, _) = common::project().await;
    for i in 1..=4 {
        a_ticket(&pid, &format!("LOOP-{i}"), &format!("Loop {i}")).await;
    }
    let mut team: HashMap<&str, String> = HashMap::new();
    for name in ["Loop A", "Loop B", "Loop C"] {
        let made = common::team_of(&pid, name, json!({})).await;
        team.insert(name, made["id"].as_str().expect("id").to_string());
    }
    let now = Utc::now();
    let ago = |minutes: i64| Some(kb_base::time::iso(&(now - Duration::minutes(minutes))));
    a_schedule(&pid, "sch_loop_due", "LOOP-1", &team["Loop A"], |s| {
        s.next_run_at = Set(ago(1));
        s.instruction = Set("Fix add().".into());
    })
    .await;
    a_schedule(&pid, "sch_loop_late", "LOOP-2", &team["Loop C"], |s| s.next_run_at = Set(ago(10))).await;
    a_schedule(&pid, "sch_loop_missed", "LOOP-3", &team["Loop B"], |s| {
        s.next_run_at = Set(ago(180));
        s.notify_people = Set("[\"Binh\"]".into());
    })
    .await;
    let once_at = now - Duration::seconds(30);
    a_schedule(&pid, "sch_loop_once", "LOOP-4", &team["Loop B"], |s| {
        s.kind = Set("once".into());
        s.run_at = Set(Some(kb_base::time::iso_naive(&once_at.naive_utc())));
        s.next_run_at = Set(Some(kb_base::time::iso(&once_at)));
    })
    .await;

    // the loop itself: every 0.3 s instead of every 20
    schedules::RT.reset();
    schedules::set_tick_s(0.3);
    assert!(!schedules::RT.running());
    schedules::start_scheduler();
    schedules::start_scheduler(); // (a second start changes nothing)
    assert!(schedules::RT.running());
    let end = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let slots = {
            let session = database::session();
            ai_schedule_run::Entity::find()
                .filter(ai_schedule_run::Column::ProjectId.eq(pid.as_str()))
                .all(&session)
                .await
                .expect("slots")
        };
        if slots.len() == 4 && slots.iter().all(|s| schedules::ENDED.contains(&s.state.as_str())) {
            break;
        }
        assert!(
            std::time::Instant::now() < end,
            "the slots never ended: {:?}",
            slots.iter().map(|s| (&s.schedule_id, &s.state, &s.note)).collect::<Vec<_>>()
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    schedules::stop_scheduler().await;
    assert!(!schedules::RT.running());
    schedules::stop_scheduler().await; // (stopping what is stopped is fine)
    schedules::set_tick_s(schedules::TICK_S);
    env.stop().await;

    let team_names: HashMap<String, String> = team.iter().map(|(name, id)| (id.clone(), name.to_string())).collect();
    let got = snapshot(&pid, &team_names).await;
    for part in ["schedules", "slots", "runs", "activity", "feed", "notifications"] {
        assert_eq!(got[part], want[part], "{part}");
    }
}

/// The board's assistant as the Python test's stand-in CLI answers: a plan as text, at a small cost.
struct Planner {
    asked: Mutex<Vec<AssistAsk>>,
}

#[async_trait::async_trait]
impl seams::Assistant for Planner {
    async fn oneshot(
        &self,
        _skill: &str,
        _inputs: Map<String, Value>,
        _by: &str,
        _model: &str,
    ) -> Result<AssistTurn, AssistFailure> {
        Err(AssistFailure::Other("not asked here".into()))
    }

    async fn turn(&self, _project_id: &str, ask: AssistAsk) -> Result<AssistTurn, AssistFailure> {
        let ticket_gone = ask.inputs["title"] == "Gone";
        let failing = ask.inputs["title"] == "Fails";
        self.asked.lock().expect("lock").push(ask);
        if ticket_gone {
            return Err(AssistFailure::Assist("Board AI is switched off for this project.".into()));
        }
        let data = json!({"text": "1) Fix the operator in calc.py."}).as_object().cloned().unwrap_or_default();
        Ok(AssistTurn {
            state: if failing { "failed".into() } else { "finished".into() },
            error: failing.then(|| "The CLI ended with exit code 1.".to_string()),
            text: "  as text  ".into(),
            structured: Some(data.clone()),
            data,
            member: "Board AI".into(),
            model: None,
            cost: 0.02,
        })
    }
}

#[tokio::test]
async fn test_a_schedule_dry_run_is_a_plan_from_the_assistant() {
    let _guard = common::init().await;
    let (pid, _) = common::project().await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let (team, _) = common::team(&pid, "Claude Code · Backend", common::TeamOpts::default()).await;
    let planner = Arc::new(Planner { asked: Mutex::new(Vec::new()) });
    seams::set_assistant(Some(planner.clone()));
    let session = database::session();
    let data = json!({"ticket_id": tid, "member_id": team.id});
    let got =
        schedules::dry_run(&session, None, &pid, data.as_object().expect("data"), "An Nguyen").await.expect("a plan");
    assert_eq!(
        Value::Object(got),
        json!({"text": "1) Fix the operator in calc.py.", "member_name": team.name, "cost": 0.02, "metered": false})
    );
    // what the assistant was asked: the skill, a new conversation of the schedule, the ticket and the run's words
    {
        let asked = planner.asked.lock().expect("lock");
        let ask = &asked[0];
        assert!(ask.name.starts_with("schedule:sch_") && ask.name.ends_with(":dry-run"), "{}", ask.name);
        assert_eq!(
            (ask.skill.as_str(), ask.feature.as_str(), ask.by.as_str()),
            ("schedule-dry-run", "schedule_dry_run", "An Nguyen")
        );
        assert_eq!(ask.ticket_id.as_deref(), Some(tid.as_str()));
        assert!(ask.fresh && ask.timeout_s == 300.0);
        assert_eq!(
            ask.inputs.keys().collect::<Vec<_>>(),
            ["ticket_id", "title", "description", "acceptance_criteria", "instruction"]
        );
        assert_eq!(ask.inputs["instruction"], json!(schedules::instruction(&schedule_of(&pid, &tid, &team.id), "")));
    }
    // a ticket that is not there: the route answers 422 (the code `invalid`)
    let data = json!({"ticket_id": "nope", "member_id": team.id});
    let refused = schedules::dry_run(&session, None, &pid, data.as_object().expect("data"), "An Nguyen").await;
    let err = refused.expect_err("no ticket");
    let err = err.schedule().expect("a ScheduleError");
    assert_eq!((err.code.as_str(), err.message.as_str()), ("invalid", "Pick a ticket first."));
    // a schedule that is not there, an assistant that refuses, a turn that fails
    let missing =
        schedules::dry_run(&session, Some("sch_nope"), &pid, &Map::new(), "An Nguyen").await.expect_err("no schedule");
    assert_eq!(missing.schedule().map(|e| e.code.as_str()), Some("not_found"));
    for (title, message) in [
        ("Gone", "The dry run failed: Board AI is switched off for this project."),
        ("Fails", "The dry run failed: The CLI ended with exit code 1."),
    ] {
        let other = common::ticket(&pid, title, "todo").await.id;
        let data = json!({"ticket_id": other, "member_id": team.id});
        let err = schedules::dry_run(&session, None, &pid, data.as_object().expect("data"), "An Nguyen")
            .await
            .expect_err("the dry run fails");
        let err = err.schedule().expect("a ScheduleError");
        assert_eq!((err.code.as_str(), err.message.as_str()), ("unavailable", message));
    }
    // with no assistant registered there is nobody to ask
    seams::set_assistant(None);
    let data = json!({"ticket_id": tid, "member_id": team.id});
    let nobody = schedules::dry_run(&session, None, &pid, data.as_object().expect("data"), "An Nguyen").await;
    assert!(matches!(nobody, Err(schedules::Error::Other(_))));
}

/// The schedule a dry run of new data is made for (only what its instruction reads).
fn schedule_of(project_id: &str, ticket_id: &str, member_id: &str) -> ai_schedule::Model {
    use kb_db::sea_orm::TryIntoModel;
    let mut s = ai_schedule::new();
    s.project_id = Set(project_id.to_string());
    s.ticket_id = Set(ticket_id.to_string());
    s.member_id = Set(member_id.to_string());
    s.created_by = Set("An Nguyen".to_string());
    s.try_into_model().expect("every column has a value")
}
