//! The account's usage window and slots (`services/ai/quota.py`) and the run limits (`services/ai/budget.py`), as the v2
//! run pipeline uses them. `test_a_weekly_limit_in_a_run_holds_the_account_and_the_next_run_waits` runs a fake CLI through
//! the REST routes and waits for `runs`.

mod common;

use chrono::{Duration, Local, Timelike, Utc};
use kb_ai::{budget, quota};
use kb_base::time;
use kb_db::database;
use kb_db::entities::{ai_account_state, ai_run, ai_team, ai_usage};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait};
use serde_json::{Value, json};

fn event(status: &str, resets: Value, kind: &str, five: f64, seven: f64) -> Value {
    json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": status,
            "resetsAt": resets,
            "rateLimitType": kind,
            "unifiedWindows": {
                "five_hour": {"utilization": five, "resetsAt": 1_900_000_000, "status": "allowed"},
                "seven_day": {"utilization": seven, "resetsAt": 1_900_100_000, "status": status},
            },
        },
    })
}

/// `(datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()`.
fn in_seconds(seconds: i64) -> String {
    time::iso(&(Utc::now() + Duration::seconds(seconds)))
}

fn reading(v: Value) -> serde_json::Map<String, Value> {
    quota::parse_event(&v).expect("a rate limit event")
}

#[test]
fn test_parse_event_reads_the_windows_and_ignores_other_events() {
    let out = reading(event("rejected", json!(1_900_000_000), "seven_day", 0.5, 1.0));
    assert!(out["status"] == json!("rejected") && out["type"] == json!("seven_day"));
    assert!(out["resets_at"].as_str().expect("text").starts_with("2030-03-17"));
    assert!(out["five_hour"]["used"] == json!(0.5) && out["seven_day"]["used"] == json!(1.0));
    assert_eq!(out["seven_day"]["status"], json!("rejected"));
    assert!(quota::parse_event(&json!({"type": "assistant"})).is_none());
    assert!(quota::parse_event(&json!("nope")).is_none());
    let bad = reading(json!({"type": "rate_limit_event", "rate_limit_info": {"resetsAt": "x"}}));
    assert_eq!(bad["resets_at"], Value::Null);
}

#[test]
fn test_key_for_picks_the_override_then_the_account_then_the_local_login() {
    let team = common::team_model("t", "p", Some("acct_team"));
    assert_eq!(quota::key_for(Some(&team), None), "acct_team");
    assert_eq!(quota::key_for(Some(&team), Some(&common::run_model("p", "t", Some("acct_run")))), "acct_run");
    assert_eq!(quota::key_for(Some(&team), Some(&common::run_model("p", "t", None))), "acct_team");
    assert_eq!(quota::key_for(Some(&common::team_model("t", "p", None)), None), "local");
    assert_eq!(quota::key_for(None, None), "local");
}

async fn state_row(key: &str) -> Option<ai_account_state::Model> {
    ai_account_state::Entity::find_by_id(key).one(&database::session()).await.expect("query")
}

#[tokio::test]
async fn test_record_keeps_the_latest_reading_and_a_rejected_window_holds() {
    let _lock = common::init().await;
    common::clear::<ai_account_state::Entity>().await;
    let row =
        quota::record("local", &reading(event("allowed", Value::Null, "five_hour", 0.65, 0.1))).await.expect("record");
    assert!(row.five_hour_used == Some(0.65) && row.held_until.is_none());
    let reset = in_seconds(3600);
    let ts = kb_ai::store::parse_iso(Some(&reset)).expect("time").timestamp();
    let row =
        quota::record("local", &reading(event("rejected", json!(ts), "seven_day", 0.7, 1.0))).await.expect("record");
    assert!(row.seven_day_used == Some(1.0) && row.seven_day_status.as_deref() == Some("rejected"));
    assert_eq!(row.held_reason.as_deref(), Some("The weekly window is used up"));
    assert!(quota::held(Some(&row), None) == row.held_until);
    assert!(row.held_until.as_deref().expect("held").starts_with(&reset[..16]));
    // a later, shorter hold never shortens the one in force
    let short = (Utc::now() + Duration::seconds(60)).timestamp();
    let row =
        quota::record("local", &reading(event("rejected", json!(short), "five_hour", 0.4, 0.1))).await.expect("record");
    assert!(row.held_until.as_deref().expect("held").starts_with(&reset[..16]));
    assert_eq!(row.held_reason.as_deref(), Some("The 5-hour window is used up"));
}

#[test]
fn test_held_is_the_reset_time_only_while_it_lies_ahead() {
    let (future, past) = (in_seconds(600), in_seconds(-600));
    assert_eq!(quota::held(None, None), None);
    assert_eq!(quota::held(Some(&quota::default_state("a")), None), None);
    let with = |until: &str| {
        let mut row = quota::default_state("a");
        row.held_until = Some(until.to_string());
        row
    };
    assert_eq!(quota::held(Some(&with(&future)), None), Some(future.clone()));
    assert_eq!(quota::held(Some(&with(&past)), None), None);
    assert_eq!(quota::held(Some(&with("garbage")), None), None);
}

async fn put_state(key: &str, held_until: Option<String>, reason: Option<&str>, max_parallel: Option<i32>) {
    let session = database::session();
    let mut row = ai_account_state::new();
    row.key = Set(key.to_string());
    row.held_until = Set(held_until);
    row.held_reason = Set(reason.map(str::to_string));
    if let Some(n) = max_parallel {
        row.max_parallel = Set(n);
    }
    row.insert(&session).await.expect("insert");
    session.commit().await.expect("commit");
}

#[tokio::test]
async fn test_release_expired_clears_only_the_holds_that_ended() {
    let _lock = common::init().await;
    common::clear::<ai_account_state::Entity>().await;
    put_state("old", Some(in_seconds(-60)), Some("x"), None).await;
    put_state("new", Some(in_seconds(600)), Some("y"), None).await;
    put_state("none", None, None, None).await;
    assert_eq!(quota::release_expired(&database::session()).await.expect("release"), ["old"]);
    let (old, new) = (state_row("old").await.expect("row"), state_row("new").await.expect("row"));
    assert!(old.held_until.is_none() && old.held_reason.is_none());
    assert!(new.held_until.is_some() && new.held_reason.as_deref() == Some("y"));
}

/// `_team_and_run(env, state, **team_extra)`: a project, a team on the fake CLI, a ticket and a run of the team.
async fn team_and_run(state: &str, opts: common::TeamOpts) -> (String, ai_team::Model, ai_run::Model) {
    let (pid, _) = common::project().await;
    let (_m, profile) = common::team(&pid, "Claude Code · Backend", opts).await;
    let ticket = common::ticket(&pid, "Fix add()", "todo").await;
    let run = common::run(&pid, &profile.id, Some(&ticket.id), state, |_| {}).await;
    (pid, profile, run)
}

async fn fresh() -> tokio::sync::MutexGuard<'static, ()> {
    let lock = common::init().await;
    common::clear::<ai_account_state::Entity>().await;
    common::clear::<ai_run::Entity>().await;
    lock
}

#[tokio::test]
async fn test_blocking_says_why_a_held_account_waits_and_not_when_free() {
    let _lock = fresh().await;
    let (_, profile, run) = team_and_run("queued", common::TeamOpts::default()).await;
    assert_eq!(quota::blocking(&database::session(), &run, &profile).await.expect("blocking"), None);
    // a check does not create the row
    assert!(state_row("local").await.is_none());
    put_state("local", Some(in_seconds(900)), Some("The weekly window is used up"), None).await;
    let why = quota::blocking(&database::session(), &run, &profile).await.expect("blocking").expect("a reason");
    assert!(why.starts_with("Waiting for the next window: The weekly window is used up, reopens "), "{why}");
}

#[tokio::test]
async fn test_blocking_counts_the_runs_going_on_the_same_account() {
    let _lock = fresh().await;
    let (pid, profile, run) = team_and_run("queued", common::TeamOpts::default()).await;
    for state in ["running", "starting", "finished"] {
        common::run(&pid, &profile.id, run.ticket_id.as_deref(), state, |_| {}).await;
    }
    put_state("local", None, None, Some(2)).await;
    let session = database::session();
    let going: Vec<String> =
        quota::running_on(&session, "local").await.expect("running").into_iter().map(|r| r.state).collect();
    assert_eq!(going, ["running", "starting"]);
    assert_eq!(
        quota::blocking(&session, &run, &profile).await.expect("blocking").as_deref(),
        Some("Waiting for a free slot on the account (2 of 2 in use)")
    );
    let mut row = state_row("local").await.expect("row");
    row.max_parallel = 3;
    kb_ai::store::save(&session, row).await.expect("save");
    session.commit().await.expect("commit");
    assert_eq!(quota::blocking(&database::session(), &run, &profile).await.expect("blocking"), None);
}

#[tokio::test]
async fn accounts_with_room_overview_and_settings() {
    let _lock = fresh().await;
    let free = common::account("Free").await;
    let busy = common::account("Busy").await;
    let held = common::account("Held").await;
    let (pid, _) = common::project().await;
    let (_m, team) = common::team(
        &pid,
        "Dev",
        common::TeamOpts { account_id: Some(busy.id.clone()), ..common::TeamOpts::default() },
    )
    .await;
    common::run(&pid, &team.id, None, "running", |_| {}).await;
    common::run(&pid, &team.id, None, "queued", |_| {}).await;
    {
        let session = database::session();
        quota::set_account(&session, &busy.id, Some(1), None).await.expect("set");
        quota::set_account(&session, &free.id, Some(500), Some(true)).await.expect("set");
        quota::hold_until(&held.id, &in_seconds(600), Some("seven_day")).await.expect("hold");
        let mut row = quota::state(&session, &free.id).await.expect("state");
        row.five_hour_used = Some(0.9);
        kb_ai::store::save(&session, row).await.expect("save");
        session.commit().await.expect("commit");
    }
    let session = database::session();
    assert_eq!(state_row(&free.id).await.expect("row").max_parallel, 20, "a limit is clamped to 1..20");
    let room = quota::room(&session, None).await.expect("room");
    assert_eq!(room.iter().map(|r| r["account_id"].as_str().expect("id")).collect::<Vec<_>>(), [free.id.as_str()]);
    assert_eq!(room[0]["free"], json!(20));
    let view = quota::overview(&database::session()).await.expect("overview");
    let of = |id: &str| view.iter().find(|v| v["key"] == json!(id)).cloned().expect("an account");
    assert_eq!(of(&busy.id)["running"].as_array().expect("list").len(), 1);
    assert_eq!(of(&busy.id)["waiting"], json!(1));
    assert_eq!(of(&held.id)["held_reason"], json!("The weekly window is used up"));
    assert!(of(&held.id)["held_until"].is_string());
    assert_eq!(of(&free.id)["move_urgent"], json!(true));
    assert_eq!(of(&free.id)["five_hour"]["used"], json!(0.9));
    assert_eq!(of(&free.id)["held_reason"], Value::Null);
}

#[test]
fn test_the_day_and_month_start_at_local_midnight_and_the_first() {
    let (today, month) = (budget::today_start(), budget::month_start(None));
    let (local_today, local_month) = (today.with_timezone(&Local), month.with_timezone(&Local));
    assert_eq!((local_today.hour(), local_today.minute(), local_today.second()), (0, 0, 0));
    assert_eq!((chrono::Datelike::day(&local_month), local_month.hour()), (1, 0));
    assert!(month <= today && today <= Utc::now());
    let date = |d: chrono::DateTime<Local>| d.format("%Y-%m-%d").to_string();
    assert_eq!(budget::day_key(None), date(local_today));
    let (key, start, end) = budget::day_bounds(0);
    assert!(key == budget::day_key(None) && start == today);
    assert!([23, 24, 25].contains(&(end - start).num_hours()));
    assert_eq!(budget::day_bounds(1).2, start);
    assert!(budget::local_day(Some("not a date")).is_none() && budget::local_day(None).is_none());
    assert_eq!(budget::local_day(Some(&time::now_iso())), Some(budget::day_key(None)));
    // a stored time without a zone is UTC
    let naive = budget::local_day(Some("2026-01-02T12:00:00")).expect("a day");
    assert!(naive == "2026-01-02" || naive == "2026-01-03");
}

/// `_schedule_runs(env, pid, team_id, n, trigger)`: n finished runs started now, and one from before today that never counts.
async fn schedule_runs(pid: &str, team_id: &str, n: usize, trigger: &str) {
    for _ in 0..n {
        common::run(pid, team_id, None, "finished", |r| {
            r.trigger = Set(trigger.to_string());
            r.started_at = Set(Some(time::now_iso()));
        })
        .await;
    }
    common::run(pid, team_id, None, "finished", |r| {
        r.trigger = Set("schedule".into());
        r.started_at = Set(Some(time::iso(&(budget::today_start() - Duration::hours(2)))));
    })
    .await;
}

#[tokio::test]
async fn test_a_team_stops_scheduled_runs_at_its_runs_per_day_and_people_are_never_held() {
    let _lock = fresh().await;
    let (pid, profile, _) =
        team_and_run("queued", common::TeamOpts { max_runs_per_day: Some(2), ..common::TeamOpts::default() }).await;
    schedule_runs(&pid, &profile.id, 1, "schedule").await;
    let settings = common::settings_model(&pid, None);
    let session = database::session();
    assert_eq!(budget::runs_today(&session, Some(&profile.id), None, &["schedule"]).await.expect("count"), 1);
    assert_eq!(budget::blocked(&session, &profile, &settings, Some("schedule")).await.expect("blocked"), None);
    schedule_runs(&pid, &profile.id, 1, "schedule").await;
    let session = database::session();
    let (label, reason) =
        budget::blocked(&session, &profile, &settings, Some("schedule")).await.expect("blocked").expect("a hit");
    assert!(label == "Runs per day used up" && reason.contains("(2 of 2)"), "{reason}");
    let hit =
        budget::blocked_detail(&session, &profile, &settings, Some("schedule")).await.expect("detail").expect("a hit");
    assert_eq!((hit["scope"].as_str(), hit["kind"].as_str()), (Some("agent"), Some("runs")));
    // a run a person starts, and a check without a run kind, are not held by a run limit
    assert_eq!(budget::blocked(&session, &profile, &settings, Some("person")).await.expect("blocked"), None);
    assert_eq!(budget::blocked(&session, &profile, &settings, None).await.expect("blocked"), None);
}

#[tokio::test]
async fn test_runs_today_counts_messages_as_automatic_unless_only_schedules_are_asked() {
    let _lock = fresh().await;
    let (pid, profile, _) = team_and_run("queued", common::TeamOpts::default()).await;
    // the queued run of the fixture has no start time: it is not counted
    schedule_runs(&pid, &profile.id, 2, "schedule").await;
    schedule_runs(&pid, &profile.id, 3, "message").await;
    schedule_runs(&pid, &profile.id, 4, "assign").await;
    let session = database::session();
    assert_eq!(budget::runs_today(&session, Some(&profile.id), None, &["schedule", "ai"]).await.expect("count"), 5);
    assert_eq!(budget::runs_today(&session, None, Some(&pid), &["schedule"]).await.expect("count"), 2);
    assert_eq!(budget::runs_today(&session, Some("someone-else"), None, &["schedule", "ai"]).await.expect("count"), 0);
    let mut run = common::run_model(&pid, "x", None);
    run.trigger = "schedule".into();
    assert_eq!(budget::run_kind(&run), "schedule");
    run.trigger = "assign".into();
    assert_eq!(budget::run_kind(&run), "person");
}

#[tokio::test]
async fn test_a_team_on_its_own_login_is_not_held_by_the_boards_runs_per_day() {
    let _lock = fresh().await;
    let (pid, mut profile, _) = team_and_run("queued", common::TeamOpts::default()).await;
    schedule_runs(&pid, &profile.id, 3, "schedule").await;
    let mut settings = common::settings_model(&pid, None);
    settings.board_runs_per_day = Some(1);
    let session = database::session();
    assert_eq!(budget::blocked(&session, &profile, &settings, Some("schedule")).await.expect("blocked"), None);
    // a metered (API key) team is held by it
    profile.connection = "api_key".into();
    let (label, reason) =
        budget::blocked(&session, &profile, &settings, Some("schedule")).await.expect("blocked").expect("a hit");
    assert!(label == "Runs per day used up" && reason.contains("Board"), "{reason}");
}

#[tokio::test]
async fn test_spend_and_tokens_add_up_metered_runs_of_today_only() {
    let _lock = fresh().await;
    let (pid, profile, _) = team_and_run("queued", common::TeamOpts::default()).await;
    let now = Utc::now();
    for (cost, metered, when) in
        [(1.5, true, now), (2.0, false, now), (4.0, true, budget::today_start() - Duration::hours(1))]
    {
        common::run(&pid, &profile.id, None, "finished", |r| {
            r.cost_usd = Set(cost);
            r.metered = Set(metered);
            r.tokens_in = Set(100);
            r.tokens_out = Set(20);
            r.started_at = Set(Some(time::iso(&when)));
        })
        .await;
    }
    let session = database::session();
    let today = budget::today_start();
    let near = |got: f64, want: f64| assert!((got - want).abs() < 1e-9, "{got} is not {want}");
    near(budget::spent(&session, today, Some(&profile.id), None, None, false).await.expect("spent"), 1.5);
    near(budget::spent(&session, today, None, Some(&pid), None, false).await.expect("spent"), 1.5);
    near(
        budget::spent(&session, today - Duration::days(1), Some(&profile.id), None, None, false).await.expect("spent"),
        5.5,
    );
    assert_eq!(budget::tokens_since(&session, today, Some(&profile.id), None).await.expect("tokens"), 120);
    assert_eq!(budget::tokens_since(&session, today, None, Some("other")).await.expect("tokens"), 0);
    // one-shot calls count toward the agent's and the project's spend
    {
        let s = database::session();
        let mut call = ai_usage::new();
        call.project_id = Set(pid.clone());
        call.member_id = Set(Some(profile.id.clone()));
        call.cost = Set(0.25);
        call.metered = Set(true);
        call.feature = Set("chat".into());
        call.insert(&s).await.expect("usage");
        s.commit().await.expect("commit");
    }
    near(budget::spent(&session, today, Some(&profile.id), None, None, false).await.expect("spent"), 1.75);
    near(budget::spent(&session, today, None, Some(&pid), None, false).await.expect("spent"), 1.75);
    assert!(budget::reports_cost(&session, &pid).await.expect("reports"));
    assert!(!budget::reports_cost(&session, "no-such-project").await.expect("reports"));
}
