//! The RAM and CPU monitor (`services/ai/resources.py`). The Python suite has no file of its own for it (the Resources
//! tab is checked through the routes and whole runs, which wait for later tasks); these tests check the module on
//! real processes (the stand-in CLI and what it starts) and on rows of a temporary database.
#![cfg(unix)]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use kb_ai::runner_link;
use kb_ai::store::get_settings;
use kb_ai_run::cli::CliProcess;
use kb_ai_run::resources::{self, MON, Timing};
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_agent};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait};
use serde_json::{Value, json};
use tokio::sync::MutexGuard;

/// `_resource_monitor_starts_empty` of the Python conftest.
async fn fresh() -> MutexGuard<'static, ()> {
    let lock = common::init().await;
    MON.reset();
    MON.set_timing(Timing::default());
    MON.set_on_breach(None);
    MON.set_on_child_breach(None);
    common::clear::<ai_run::Entity>().await;
    common::clear::<ai_run_agent::Entity>().await;
    runner_link::set_mode(None);
    runner_link::set_in_runner(None);
    lock
}

async fn run_row(id: &str) -> ai_run::Model {
    ai_run::Entity::find_by_id(id).one(&database::session()).await.expect("query").expect("the run")
}

async fn set_limit(project_id: &str, mb: i32) {
    let session = database::session();
    let read = get_settings(&session, project_id).await.expect("settings");
    let mut settings = read.clone();
    settings.run_memory_limit_mb = mb;
    kb_db::save_model(&session, &read, settings).await.expect("save");
    session.commit().await.expect("commit");
    MON.limit_changed(project_id);
}

/// A stand-in CLI that started a child and waits (mode `spawn`): (the process, the child's pid).
async fn cli_with_a_child() -> (Arc<CliProcess>, i32) {
    let repo = common::tmp_path("repo");
    let pidfile = repo.join("child.pid");
    let env = common::fake_env("spawn", &[("FAKE_CLAUDE_PIDFILE", &pidfile.to_string_lossy())]);
    let proc = Arc::new(CliProcess::new(common::stream_args("x", "s"), &repo.to_string_lossy(), Some(env), true, None));
    proc.start().await.expect("start");
    let mut lines = proc.lines();
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(10), lines.next()).await.expect("in time").expect("a line");
    }
    let child = std::fs::read_to_string(&pidfile).expect("the pid file").trim().parse().expect("a pid");
    (proc, child)
}

#[tokio::test]
async fn the_machine_is_read_with_its_ram_load_and_cores() {
    let _lock = fresh().await;
    let machine = resources::read_machine();
    assert_eq!(machine.keys().collect::<Vec<_>>(), ["ram_total_mb", "ram_free_mb", "load1", "cores"]);
    let (total, free) =
        (machine["ram_total_mb"].as_i64().expect("an integer"), machine["ram_free_mb"].as_i64().expect("an integer"));
    assert!(total > 64 && free > 0 && free <= total, "{machine:?}");
    assert!(machine["load1"].as_f64().is_some_and(|l| l >= 0.0));
    assert!(machine["cores"].as_u64().is_some_and(|c| c >= 1));
    assert_eq!((resources::SAMPLE_S, resources::HISTORY_EVERY_S, resources::HISTORY_POINTS), (2.0, 5.0, 60));
    assert_eq!(
        (resources::SAVE_EVERY_S, resources::LIMIT_TTL_S, resources::AUTO_RESTARTS, resources::ENDED_SHOWN_S),
        (15.0, 10.0, 2, 600)
    );
    assert_eq!(
        resources::dump(&json!([{"at": "x", "by": "Hệ thống", "n": 1}])),
        "[{\"at\": \"x\", \"by\": \"Hệ thống\", \"n\": 1}]"
    );
}

#[tokio::test]
async fn a_run_is_read_as_the_cli_and_what_it_started() {
    let _lock = fresh().await;
    let (proc, child) = cli_with_a_child().await;
    let pid = proc.pid().expect("pid");
    let first = resources::read_run(pid).expect("a running CLI");
    assert!(first.readable && first.at.is_none());
    assert!(first.cli_rss_mb.is_some_and(|mb| mb > 0.0), "{first:?}");
    assert!(first.extra_mb.is_some_and(|mb| mb > 0.0), "the child is counted apart: {first:?}");
    assert!(first.cpu_pct.is_some_and(|pct| (0.0..=6400.0).contains(&pct)));
    // one decimal, as `round(x, 1)`
    let one_decimal = |x: f64| ((x * 10.0).round() - x * 10.0).abs() < 1e-9;
    assert!(one_decimal(first.cli_rss_mb.unwrap_or(0.5)) && one_decimal(first.extra_mb.unwrap_or(0.5)));
    // the child alone has nothing under it
    let alone = resources::read_run(child).expect("the child");
    assert_eq!(alone.extra_mb, Some(0.0));
    proc.kill();
    proc.wait().await.expect("wait");
    common::until("the child's exit", 8.0, || !common::alive(child)).await;
    resources::forget_dead();
    assert_eq!(resources::read_run(pid), None);
    assert_eq!(resources::read_run(child), None);
    assert_eq!(resources::read_run(-1), None);
}

#[tokio::test]
async fn the_monitor_reads_a_tracked_cli_saves_it_with_the_run_and_tells_who_watches() {
    let _lock = fresh().await;
    let (project, _) = common::project().await;
    let (team, _) = common::team(&project, "Claude Code · Backend", common::TeamOpts::default()).await;
    let ticket = common::ticket(&project, "Fix add()", "todo").await;
    let run = common::run(&project, &team.id, Some(&ticket.id), "running", |r| {
        r.started_at = Set(Some(kb_base::time::now_iso()))
    })
    .await;
    MON.set_timing(Timing { sample_s: 0.25, history_every_s: 0.25, save_every_s: 0.25, limit_ttl_s: 10.0 });
    let breaches: Arc<Mutex<Vec<(String, String, f64, i64)>>> = Arc::default();
    let note = |kind: &'static str| -> resources::Breach {
        let breaches = breaches.clone();
        Arc::new(move |run_id, mb, limit| {
            let breaches = breaches.clone();
            Box::pin(async move { breaches.lock().expect("lock").push((kind.to_string(), run_id, mb, limit)) })
        })
    };
    MON.set_on_breach(Some(note("cli")));
    MON.set_on_child_breach(Some(note("child")));
    assert!(!MON.running() && MON.live().is_empty());

    let events = kb_base::events::subscribe();
    let (proc, child) = cli_with_a_child().await;
    let pid = proc.pid().expect("pid");
    MON.track(&run.id, proc.clone(), &project);
    assert!(MON.running());
    assert_eq!(MON.live(), [(run.id.clone(), pid, project.clone())]);
    common::until("a reading", 10.0, || MON.reading(&run.id).is_some()).await;
    let reading = MON.reading(&run.id).expect("a reading");
    assert!(reading.readable && reading.at.is_some() && reading.cli_rss_mb.is_some_and(|mb| mb > 0.0));
    common::until("two history points", 10.0, || MON.history(&run.id).len() >= 2).await;
    let point = MON.history(&run.id)[0].clone();
    assert_eq!(point.as_object().expect("a point").keys().collect::<Vec<_>>(), ["at", "rss_mb", "cpu_pct"]);
    let peak = MON.peak(&run.id).expect("a peak");
    assert!(peak >= reading.cli_rss_mb.unwrap_or(0.0));
    // saved with the run
    let mut saved = run_row(&run.id).await;
    for _ in 0..40 {
        if saved.last_rss_mb.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        saved = run_row(&run.id).await;
    }
    assert!(saved.last_rss_mb.is_some_and(|mb| mb > 0.0) && saved.peak_rss_mb.is_some_and(|mb| mb > 0.0));
    assert!(breaches.lock().expect("lock").is_empty(), "far under the project's limit: no breach");

    // someone watches: the snapshot of the project, the newest only
    let watcher = MON.subscribe(&project);
    let snap = tokio::time::timeout(Duration::from_secs(10), watcher.get()).await.expect("a snapshot in time");
    assert_eq!(
        snap.as_object().expect("a snapshot").keys().collect::<Vec<_>>(),
        ["project_id", "at", "machine", "limits", "runs"]
    );
    let settings = get_settings(&database::session(), &project).await.expect("settings");
    assert_eq!(
        snap["limits"],
        json!({"run_memory_limit_mb": settings.run_memory_limit_mb, "auto_restarts": 2, "board_max_parallel": settings.board_max_parallel})
    );
    assert!(snap["machine"]["cli_count"] == 1 && snap["machine"]["ai_rss_mb"].as_f64().is_some_and(|mb| mb > 0.0));
    let row = &snap["runs"][0];
    assert_eq!(
        row.as_object().expect("a row").keys().collect::<Vec<_>>(),
        [
            "run_id",
            "number",
            "member_id",
            "member_name",
            "member_color",
            "ticket_id",
            "ticket_title",
            "state",
            "started_at",
            "ended_at",
            "ended_reason",
            "stop_code",
            "roles_working",
            "live",
            "readable",
            "cli_rss_mb",
            "extra_mb",
            "cpu_pct",
            "peak_rss_mb",
            "restarts",
            "history",
        ]
    );
    assert!(row["run_id"] == run.id.as_str() && row["live"] == true && row["readable"] == true);
    assert!(
        row["member_name"] == "Claude Code · Backend"
            && row["ticket_title"] == "Fix add()"
            && row["state"] == "running"
    );
    assert!(
        row["cli_rss_mb"].as_f64().is_some_and(|mb| mb > 0.0) && row["extra_mb"].as_f64().is_some_and(|mb| mb > 0.0)
    );
    assert!(row["history"].as_array().is_some_and(|h| !h.is_empty()) && row["restarts"] == json!([]));
    // and the same goes out as a typed event, for the app in the other process
    let mut announced = false;
    for _ in 0..200 {
        match events.try_recv() {
            Some(event) if event.contains("\"type\": \"ai.resources\"") => {
                let event: Value = serde_json::from_str(&event).expect("an event");
                announced = event["project_id"] == project.as_str() && event["runs"][0]["run_id"] == run.id.as_str();
                break;
            }
            Some(_) => {}
            None => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    assert!(announced, "ai.resources was published");
    let card = resources::card_view(&run_row(&run.id).await, 512).expect("a card");
    assert_eq!(
        card.as_object().expect("a card").keys().collect::<Vec<_>>(),
        ["cli_rss_mb", "extra_mb", "cpu_pct", "peak_rss_mb", "readable", "restarts", "limit_mb"]
    );
    assert!(
        card["limit_mb"] == 512
            && card["restarts"] == 0
            && card["readable"] == true
            && card["peak_rss_mb"].as_f64().is_some_and(|mb| mb > 0.0)
    );

    // a limit of 1 MB: the CLI and what it started are both over it, each told once
    set_limit(&project, 1).await;
    assert_eq!(MON.limit_mb(&project).await.expect("limit"), 1);
    common::until("both breaches", 10.0, || breaches.lock().expect("lock").len() >= 2).await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let told = breaches.lock().expect("lock").clone();
    assert_eq!(
        told.iter().map(|(kind, run_id, _, limit)| (kind.as_str(), run_id.as_str(), *limit)).collect::<Vec<_>>(),
        [("cli", run.id.as_str(), 1), ("child", run.id.as_str(), 1)]
    );
    assert!(told.iter().all(|(_, _, mb, _)| *mb > 1.0));
    // the new CLI after a restart is tracked again, and may breach again
    MON.track(&run.id, proc.clone(), &project);
    common::until("the breach of the restarted CLI", 10.0, || {
        breaches.lock().expect("lock").iter().filter(|b| b.0 == "cli").count() == 2
    })
    .await;

    // the CLI ended: its numbers stay with the run, the monitor forgets the reading
    MON.unsubscribe(&project, &watcher);
    MON.untrack(&run.id).await.expect("untrack");
    assert!(MON.reading(&run.id).is_none() && MON.live().is_empty());
    assert!(resources::card_view(&run_row(&run.id).await, 0).is_some(), "the peak is still shown");
    common::until("the loop ends with nothing to read", 10.0, || !MON.running()).await;
    proc.kill();
    proc.wait().await.expect("wait");
    common::until("the child's exit", 8.0, || !common::alive(child)).await;
    MON.reset();
}

#[tokio::test]
async fn the_snapshot_lists_running_runs_and_those_that_ended_a_moment_ago() {
    let _lock = fresh().await;
    let (project, _) = common::project().await;
    let (other_project, _) = common::project().await;
    let (team, _) = common::team(&project, "Claude Code · Backend", common::TeamOpts::default()).await;
    let ticket = common::ticket(&project, "Fix add()", "todo").await;
    let now = chrono::Utc::now();
    let ago = |seconds: i64| Some(kb_base::time::iso(&(now - chrono::Duration::seconds(seconds))));
    let running = common::run(&project, &team.id, Some(&ticket.id), "running", |r| {
        r.last_rss_mb = Set(Some(kb_db::Float(310.5)));
        r.peak_rss_mb = Set(Some(kb_db::Float(420.0)));
        r.restarts = Set(
            "[{\"at\": \"x\", \"rss_mb\": 900.0, \"limit_mb\": 512, \"by\": \"system\", \"n\": 1}, \"odd\"]".into(),
        );
    })
    .await;
    let starting = common::run(&project, &team.id, None, "starting", |_| {}).await;
    let ended = common::run(&project, &team.id, Some(&ticket.id), "done", |r| {
        r.ended_at = Set(ago(60));
        r.peak_rss_mb = Set(Some(kb_db::Float(512.25)));
        r.last_rss_mb = Set(Some(kb_db::Float(100.0)));
        r.ended_reason = Set(Some("finished".into()));
    })
    .await;
    common::run(&project, &team.id, None, "done", |r| {
        r.ended_at = Set(ago(3600));
        r.peak_rss_mb = Set(Some(kb_db::Float(1.0)));
    })
    .await;
    common::run(&project, &team.id, None, "done", |r| r.ended_at = Set(ago(30))).await; // never measured
    common::run(&project, &team.id, None, "queued", |_| {}).await;
    common::run(&other_project, &team.id, None, "running", |_| {}).await;
    let session = database::session();
    for (role, ended_at) in [("reviewer", None), ("tester", None), ("writer", Some(kb_base::time::now_iso()))] {
        let mut agent = ai_run_agent::new();
        agent.id = Set(kb_base::time::prefixed_id("agent_", 12));
        agent.run_id = Set(running.id.clone());
        agent.agent_type = Set(role.to_string());
        agent.ended_at = Set(ended_at);
        agent.insert(&session).await.expect("agent");
    }
    session.commit().await.expect("commit");

    // in one process nothing is live without a tracked CLI: the rows show what was saved
    let snap = resources::snapshot(&project).await.expect("snapshot");
    assert_eq!(snap["project_id"], project.as_str());
    let ids: Vec<&str> =
        snap["runs"].as_array().expect("runs").iter().map(|r| r["run_id"].as_str().expect("id")).collect();
    assert_eq!(ids.len(), 3, "{ids:?}");
    assert_eq!(ids[0], running.id, "the heaviest first");
    assert!(ids.contains(&starting.id.as_str()) && ids.contains(&ended.id.as_str()));
    let row =
        |id: &str| snap["runs"].as_array().expect("runs").iter().find(|r| r["run_id"] == id).expect("the row").clone();
    let first = row(&running.id);
    assert!(
        first["live"] == false
            && first["readable"] == true
            && first["cli_rss_mb"] == 310.5
            && first["peak_rss_mb"] == 420.0
    );
    assert!(first["extra_mb"].is_null() && first["cpu_pct"].is_null() && first["history"] == json!([]));
    assert_eq!(first["roles_working"], json!(["reviewer", "tester"]));
    assert_eq!(first["restarts"], json!([{"at": "x", "rss_mb": 900.0, "limit_mb": 512, "by": "system", "n": 1}]));
    assert!(
        row(&starting.id)["ticket_id"].is_null()
            && row(&starting.id)["ticket_title"].is_null()
            && row(&starting.id)["roles_working"] == json!([])
    );
    assert!(row(&ended.id)["peak_rss_mb"] == 512.25 && row(&ended.id)["ended_reason"] == "finished");
    assert_eq!(
        serde_json::to_string(&snap["machine"]["ai_rss_mb"]).expect("json"),
        "0",
        "nothing measured: Python's integer 0"
    );
    assert_eq!(snap["machine"]["cli_count"], 0);

    // the CLIs live in the runner process: a run that works has one, shown with the numbers the runner saved
    runner_link::set_mode(Some("process"));
    runner_link::set_in_runner(Some(false));
    let snap = resources::snapshot(&project).await.expect("snapshot");
    let rows = snap["runs"].as_array().expect("runs");
    assert!(rows[0]["run_id"] == running.id.as_str() && rows[0]["live"] == true && rows[0]["cli_rss_mb"] == 310.5);
    assert!(rows.iter().filter(|r| r["live"] == true).count() == 1);
    assert_eq!(snap["machine"]["ai_rss_mb"], 310.5);
    assert_eq!(snap["machine"]["cli_count"], 1);
    runner_link::set_in_runner(Some(true));
    assert_eq!(
        resources::snapshot(&project).await.expect("snapshot")["machine"]["cli_count"],
        0,
        "the runner reads its own CLIs"
    );
    runner_link::set_mode(None);
    runner_link::set_in_runner(None);

    // the card in Now
    let card = resources::card_view(&running, 512).expect("a card");
    assert_eq!(
        card,
        json!({"cli_rss_mb": 310.5, "extra_mb": null, "cpu_pct": null, "peak_rss_mb": 420.0, "readable": true, "restarts": 1, "limit_mb": 512})
    );
    assert_eq!(resources::card_view(&starting, 512), None);
    assert_eq!(resources::restarts_of(&starting), Vec::<Value>::new());
    let mut broken = starting.clone();
    broken.restarts = "{not json".into();
    assert_eq!(resources::restarts_of(&broken), Vec::<Value>::new());
}
