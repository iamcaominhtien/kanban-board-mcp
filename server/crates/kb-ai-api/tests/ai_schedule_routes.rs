//! One check per route of `api/schedules.py` (what a team does on a ticket at a set time): the answer of each route,
//! for the success case and for each error branch (`{"detail", "code", "problems"?}` with the status its code maps
//! to), must be what the Python server answers. Schedules are on dates far ahead, so that nothing in an answer moves
//! with the day the test runs; what does is left out of the comparison and said where. Recorded from the Python
//! server in `contract/golden/ai_schedule_routes/<test>.json`:
//!
//! `AI_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-ai-api --test ai_schedule_routes`

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use common::rec::Rec;
use common::{Fixture, id, insert, project, start, ticket, tmp};
use serde_json::json;

/// A team on the stand-in CLI.
async fn make_team(f: &Fixture, pid: &str, name: &str) -> String {
    let repo = tmp(f).join("repo");
    std::fs::create_dir_all(&repo).expect("repo folder");
    let r = f
        .c
        .post(
            &format!("/projects/{pid}/ai/teams"),
            json!({"name": name, "working_dir": repo.to_string_lossy(), "cli_path": f.bin.join("claude").to_string_lossy()}),
        )
        .await;
    r.assert_status(201);
    id(&r.json())
}

#[tokio::test]
async fn schedule_routes() {
    let name = "schedule_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    std::fs::write(f.claude.join(".fake-login"), "an@work.example").expect("login file");
    let mut rec = Rec::new("ai_schedule_routes", name, &[&tmp(&f), f.server.dir()]);
    // what depends on the day the test runs: how far away the next run of the repeating schedule is, what it is
    // called ("in 14 h 16 m", "Fri 13"), and whether it is within the next day
    rec.ignore(&["next_in", "in", "day", "label", "next24h"]);
    let (pid, _an) = project(c).await;
    let team = make_team(&f, &pid, "Dev An").await;
    let other_team = make_team(&f, &pid, "Dev Binh").await;
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    let t2 = ticket(c, &pid, "Write the docs", "todo").await;
    let list = format!("/projects/{pid}/ai/schedules");
    let once = json!({"ticket_id": t1, "member_id": team, "kind": "once", "run_at": "2099-06-15T09:30:00+00:00",
                      "tz": "UTC", "instruction": "Fix the operator in calc.py."});
    let repeat = json!({"ticket_id": t2, "member_id": team, "kind": "repeat", "days": [0, 2, 4], "time": "09:00",
                        "tz": "UTC", "ends": "after", "ends_after": 5});

    rec.check("GET schedules: none", &c.get(&list).await);
    rec.check("GET schedules: no such project", &c.get("/projects/nope/ai/schedules").await);
    rec.check("GET history: none", &c.get(&format!("{list}/history")).await);
    rec.check("GET history: limit 0", &c.get(&format!("{list}/history?limit=0")).await);
    rec.check("GET history: limit 201", &c.get(&format!("{list}/history?limit=201")).await);
    rec.check("GET history: limit is text", &c.get(&format!("{list}/history?limit=many")).await);
    rec.check("GET history: no such project", &c.get("/projects/nope/ai/schedules/history").await);
    rec.check("GET week: none", &c.get(&format!("{list}/week?start=2099-06-15")).await);
    rec.check("GET week: bad start", &c.get(&format!("{list}/week?start=next-monday")).await);
    rec.check("GET week: days 0", &c.get(&format!("{list}/week?days=0")).await);
    rec.check("GET week: days 32", &c.get(&format!("{list}/week?days=32")).await);
    rec.check("GET week: no such project", &c.get("/projects/nope/ai/schedules/week").await);
    rec.check("GET cards: none", &c.get(&format!("{list}/cards")).await);
    rec.check("GET cards: no such project", &c.get("/projects/nope/ai/schedules/cards").await);
    rec.check("GET events: none", &c.get(&format!("{list}/events")).await);
    rec.check("GET events: after 5", &c.get(&format!("{list}/events?after=5")).await);
    rec.check("GET events: after is text", &c.get(&format!("{list}/events?after=x")).await);
    rec.check("GET events: no such project", &c.get("/projects/nope/ai/schedules/events").await);

    // preview and checks
    let preview = format!("{list}/preview");
    rec.check("POST preview: no such project", &c.post("/projects/nope/ai/schedules/preview", once.clone()).await);
    rec.check("POST preview: no body", &c.post_empty(&preview).await);
    rec.check("POST preview: days is text", &c.post(&preview, json!({"days": "mon"})).await);
    rec.check("POST preview: days holds text", &c.post(&preview, json!({"days": ["mon"]})).await);
    rec.check("POST preview: limits is a list", &c.post(&preview, json!({"limits": []})).await);
    rec.check("POST preview: schedule_id is a number", &c.post(&preview, json!({"schedule_id": 3})).await);
    rec.check("POST preview: nothing", &c.post(&preview, json!({})).await);
    rec.check("POST preview: once", &c.post(&preview, once.clone()).await);
    rec.check("POST preview: repeat", &c.post(&preview, repeat.clone()).await);
    rec.check(
        "POST preview: no day",
        &c.post(
            &preview,
            json!({"ticket_id": t1, "member_id": team, "kind": "repeat", "days": [], "time": "09:00", "tz": "UTC"}),
        )
        .await,
    );
    rec.check(
        "POST preview: a kind that is not one",
        &c.post(&preview, json!({"ticket_id": t1, "member_id": team, "kind": "monthly"})).await,
    );
    rec.check("POST preview: a zone that is not one", &c.post(&preview, json!({"ticket_id": t1, "member_id": team, "kind": "once", "run_at": "2099-06-15T09:30:00+00:00", "tz": "Mars/Base"})).await);
    rec.check("POST preview: limits out of range", &c.post(&preview, json!({"ticket_id": t1, "member_id": team, "kind": "once", "run_at": "2099-06-15T09:30:00+00:00", "tz": "UTC", "limits": {"stop_after_min": 1, "retries": 9}})).await);
    rec.check("POST preview: the backup is the team", &c.post(&preview, json!({"ticket_id": t1, "member_id": team, "backup_member_id": team, "kind": "once", "run_at": "2099-06-15T09:30:00+00:00", "tz": "UTC"})).await);
    rec.check("POST preview: a schedule that is not there", &c.post(&preview, json!({"schedule_id": "nope"})).await);

    // create
    rec.check("POST create: no such project", &c.post("/projects/nope/ai/schedules", once.clone()).await);
    rec.check("POST create: no body", &c.post_empty(&list).await);
    rec.check("POST create: ends_after is a fraction", &c.post(&list, json!({"ends_after": 1.5})).await);
    rec.check("POST create: nothing", &c.post(&list, json!({})).await);
    rec.check(
        "POST create: no ticket",
        &c.post(&list, json!({"member_id": team, "kind": "once", "run_at": "2099-06-15T09:30:00+00:00", "tz": "UTC"}))
            .await,
    );
    rec.check("POST create: no such ticket", &c.post(&list, json!({"ticket_id": "nope", "member_id": team, "kind": "once", "run_at": "2099-06-15T09:30:00+00:00", "tz": "UTC"})).await);
    rec.check("POST create: no such team", &c.post(&list, json!({"ticket_id": t1, "member_id": "nope", "kind": "once", "run_at": "2099-06-15T09:30:00+00:00", "tz": "UTC"})).await);
    let first = c.post(&list, once.clone()).await;
    rec.check("POST create: once", &first);
    first.assert_status(201);
    let s1 = id(&first.json());
    let second = c.post(&list, repeat.clone()).await;
    rec.check("POST create: repeat", &second);
    second.assert_status(201);
    let s2 = id(&second.json());
    rec.check("POST create: a second one on the same ticket", &c.post(&list, once.clone()).await);
    rec.check("GET schedules", &c.get(&list).await);
    rec.check("GET schedules: one ticket", &c.get(&format!("{list}?ticket_id={t1}")).await);
    rec.check("GET schedules: another ticket", &c.get(&format!("{list}?ticket_id=nope")).await);
    rec.check("GET week", &c.get(&format!("{list}/week?start=2099-06-14&days=3")).await);
    rec.check("GET week: with a zone", &c.get(&format!("{list}/week?start=2099-06-15T00:00:00%2B07:00&days=2")).await);
    rec.check("GET cards", &c.get(&format!("{list}/cards")).await);
    rec.check(
        "POST preview: an existing schedule, edited",
        &c.post(&preview, json!({"schedule_id": s1, "time": "10:00"})).await,
    );

    // read, edit, pause, resume
    let one = format!("/ai/schedules/{s1}");
    rec.check("GET schedule", &c.get(&one).await);
    rec.check("GET schedule: not found", &c.get("/ai/schedules/nope").await);
    rec.check("PATCH schedule: not found", &c.patch("/ai/schedules/nope", json!({"instruction": "x"})).await);
    rec.check("PATCH schedule: no body", &c.request("PATCH", &one, &[], None).await);
    rec.check("PATCH schedule: nothing", &c.patch(&one, json!({})).await);
    rec.check("PATCH schedule: another ticket", &c.patch(&one, json!({"ticket_id": t2})).await);
    rec.check(
        "PATCH schedule: the same ticket",
        &c.patch(&one, json!({"ticket_id": t1, "instruction": "Fix it, then run the tests."})).await,
    );
    rec.check("PATCH schedule: the team", &c.patch(&one, json!({"member_id": other_team, "backup_member_id": team, "notify": ["failed"], "notify_people": ["An Nguyen"], "limits": {"stop_after_min": 30, "retries": 2}, "catch_up": "ask", "catch_up_hours": 2.5})).await);
    rec.check("PATCH schedule: a catch-up that is not one", &c.patch(&one, json!({"catch_up": "never"})).await);
    rec.check("POST pause: not found", &c.post_empty("/ai/schedules/nope/pause").await);
    rec.check("POST pause", &c.post_empty(&format!("{one}/pause")).await);
    rec.check("GET cards: paused", &c.get(&format!("{list}/cards")).await);
    rec.check("POST resume: not found", &c.post_empty("/ai/schedules/nope/resume").await);
    rec.check("POST resume", &c.post_empty(&format!("{one}/resume")).await);
    rec.check("GET schedule: after", &c.get(&one).await);

    // slots
    rec.check("POST run-now: not found", &c.post_empty("/ai/schedules/nope/run-now").await);
    rec.check("POST action: not found", &c.post("/ai/schedule-runs/nope/action", json!({"action": "skip"})).await);
    rec.check("POST action: no body", &c.post_empty("/ai/schedule-runs/nope/action").await);
    rec.check("POST action: no action", &c.post("/ai/schedule-runs/nope/action", json!({})).await);
    insert(
        &f.server,
        "ai_schedule_run",
        &json!({"id": "srun_000000000001", "schedule_id": s2, "project_id": pid, "ticket_id": t2,
                "slot_at": "2099-06-15T09:00:00+00:00", "state": "waiting", "catch_up": true, "member_id": team,
                "run_ids": "[]", "attempts": 0, "fix_round": 0, "results": "{}", "review": "{}", "duration_s": 0,
                "cost_usd": 0.0, "created_at": common::NOW, "updated_at": common::NOW}),
    )
    .await;
    rec.check(
        "POST action: not a slot action",
        &c.post("/ai/schedule-runs/srun_000000000001/action", json!({"action": "dance"})).await,
    );
    rec.check(
        "POST action: another team, not a team",
        &c.post("/ai/schedule-runs/srun_000000000001/action", json!({"action": "use_member", "member_id": "nope"}))
            .await,
    );
    rec.check(
        "POST action: skip",
        &c.post("/ai/schedule-runs/srun_000000000001/action", json!({"action": "skip"})).await,
    );
    rec.check(
        "POST action: skip again",
        &c.post("/ai/schedule-runs/srun_000000000001/action", json!({"action": "skip"})).await,
    );
    rec.check("GET history", &c.get(&format!("{list}/history")).await);
    rec.check("GET schedule: with a run", &c.get(&format!("/ai/schedules/{s2}")).await);
    // (the id of a notice is the millisecond it was made in)
    rec.check_hiding("GET events: after the skip", &c.get(&format!("{list}/events")).await, &["id"]);

    // dry run (the plan comes from the assistant: its own test), and delete
    let dry = format!("{list}/dry-run");
    rec.check(
        "POST dry-run: no such project",
        &c.post("/projects/nope/ai/schedules/dry-run", json!({"ticket_id": t1, "member_id": team})).await,
    );
    rec.check("POST dry-run: no body", &c.post_empty(&dry).await);
    rec.check("POST dry-run: no such ticket", &c.post(&dry, json!({"ticket_id": "nope", "member_id": team})).await);
    rec.check("POST dry-run: no such team", &c.post(&dry, json!({"ticket_id": t1, "member_id": "nope"})).await);
    rec.check("POST dry-run: a schedule that is not there", &c.post(&dry, json!({"schedule_id": "nope"})).await);
    rec.check("DELETE schedule: not found", &c.delete("/ai/schedules/nope").await);
    rec.check("DELETE schedule", &c.delete(&one).await);
    rec.check("DELETE schedule: again", &c.delete(&one).await);
    rec.check("GET schedule: deleted", &c.get(&one).await);
    rec.check("DELETE schedule: with runs", &c.delete(&format!("/ai/schedules/{s2}")).await);
    rec.check("GET schedules: none left", &c.get(&list).await);
    rec.finish();
}

/// A schedule that is run by hand: the team works the slot on the ticket and the slot ends with a verdict.
#[tokio::test]
async fn run_now_routes() {
    let name = "run_now_routes";
    let Some(f) = start(name, true, &[("FAKE_CLAUDE_MODE", "v2")]).await else { return };
    let c = &f.c;
    std::fs::write(f.claude.join(".fake-login"), "an@work.example").expect("login file");
    let mut rec = Rec::new("ai_schedule_routes", name, &[&tmp(&f), f.server.dir()]);
    // what a run measures, and how long the slot took
    rec.ignore(&[
        "duration_s",
        "cost_usd",
        "steps_count",
        "tokens_in",
        "tokens_out",
        "peak_rss_mb",
        "last_rss_mb",
        "pid",
        "model",
        "files",
    ]);
    let (pid, _an) = project(c).await;
    let team = make_team(&f, &pid, "Dev An").await;
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    let list = format!("/projects/{pid}/ai/schedules");
    let made = c
        .post(
            &list,
            json!({"ticket_id": t1, "member_id": team, "kind": "once", "run_at": "2099-06-15T09:30:00+00:00",
                            "tz": "UTC", "instruction": "Fix the operator in calc.py."}),
        )
        .await;
    made.assert_status(201);
    let sid = id(&made.json());
    let run = c.post_empty(&format!("/ai/schedules/{sid}/run-now")).await;
    run.assert_status(200);
    // the slot is a race with the scheduler's tick until it settles
    let end = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    let settled = loop {
        let history = c.get(&format!("{list}/history")).await.json();
        let slot = history.as_array().and_then(|h| h.first()).cloned();
        if let Some(slot) = slot
            .filter(|s| matches!(s["state"].as_str(), Some("passed" | "partly" | "failed" | "skipped" | "cancelled")))
        {
            break slot;
        }
        assert!(tokio::time::Instant::now() < end, "the slot never settled: {history}");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };
    rec.note("the slot ended as", json!({"state": settled["state"]}));
    rec.check_hiding(
        "POST run-now",
        &run,
        &["state", "started_at", "ended_at", "run_ids", "note", "results", "review"],
    );
    rec.check_hiding(
        "GET history: after the run",
        &c.get(&format!("{list}/history")).await,
        &["run_ids", "note", "results", "review"],
    );
    rec.check_hiding(
        "GET schedule: after the run",
        &c.get(&format!("/ai/schedules/{sid}")).await,
        &["run_ids", "note", "results", "review"],
    );
    rec.check("POST run-now: again", &c.post_empty(&format!("/ai/schedules/{sid}/run-now")).await);
    rec.finish();
}
