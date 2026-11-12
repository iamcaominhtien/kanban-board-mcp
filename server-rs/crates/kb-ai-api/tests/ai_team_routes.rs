//! One check per route of the AI team's own router (`api/ai.py`) and of the one route of `api/ai_accounts.py` that
//! needs a team (`PUT /ai/teams/{id}/account`): the answer of each route, for the success case and for each error
//! branch, must be what the Python server answers. The expected answers are recorded from the Python server in
//! `contract/golden/ai_team_routes/<test>.json` and compared on both targets:
//!
//! `AI_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-ai-api --test ai_team_routes`
//!
//! Teams are made through the route, on the stand-in CLI (see `tests/common`); runs are started the way a person
//! starts them and followed until they rest.

mod common;

use std::path::PathBuf;
use std::time::Duration;

use common::rec::Rec;
use common::{Fixture, account, exec, id, login, project, start, ticket};
use serde_json::{Value, json};
use testkit::Client;

/// The folder of the test (the parent of the accounts' folder).
fn tmp(f: &Fixture) -> PathBuf {
    f.accounts.parent().expect("the test's folder").to_path_buf()
}

/// A repository folder inside the test's folder, with the file the Python tests use.
fn repo(f: &Fixture) -> PathBuf {
    let repo = tmp(f).join("repo");
    std::fs::create_dir_all(&repo).expect("repo folder");
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a - b\n").expect("calc.py");
    repo
}

/// The login of this computer is signed in (the stand-in CLI answers `auth status` from this file).
fn sign_in(f: &Fixture) {
    std::fs::write(f.claude.join(".fake-login"), "an@work.example").expect("login file");
}

/// A team on the stand-in CLI (`_runner` of `ai_helpers.py`).
async fn make_team(f: &Fixture, pid: &str, name: &str, extra: Value) -> Value {
    let mut body = json!({
        "name": name,
        "working_dir": repo(f).to_string_lossy(),
        "cli_path": f.bin.join("claude").to_string_lossy(),
        "model": "haiku",
    });
    for (key, value) in extra.as_object().expect("extra") {
        body[key] = value.clone();
    }
    let r = f.c.post(&format!("/projects/{pid}/ai/teams"), body).await;
    r.assert_status(201);
    r.json()
}

/// Wait until the newest run of the ticket is in one of the states.
async fn wait_run(c: &Client, ticket_id: &str, states: &[&str]) -> Value {
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let runs = c.get(&format!("/tickets/{ticket_id}/ai/runs")).await.json();
        if let Some(run) = runs.as_array().and_then(|r| r.first()) {
            if states.contains(&run["state"].as_str().unwrap_or("")) {
                return run.clone();
            }
        }
        assert!(tokio::time::Instant::now() < end, "the run never reached {states:?}: {runs}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ---------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------

#[tokio::test]
async fn team_routes() {
    let name = "team_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    sign_in(&f);
    let mut rec = Rec::new("ai_team_routes", name, &[&tmp(&f)]);
    let (pid, an) = project(c).await;
    rec.check("GET /ai/packs/teams", &c.get("/ai/packs/teams").await);
    rec.check("GET /ai/packs/roles", &c.get("/ai/packs/roles").await);
    rec.check("GET teams: no such project", &c.get("/projects/nope/ai/teams").await);
    rec.check("GET teams: none", &c.get(&format!("/projects/{pid}/ai/teams")).await);

    // create
    let url = format!("/projects/{pid}/ai/teams");
    let dir = repo(&f).to_string_lossy().into_owned();
    let cli = f.bin.join("claude").to_string_lossy().into_owned();
    let made = |extra: Value| {
        let mut body = json!({"name": "Dev An", "working_dir": dir, "cli_path": cli});
        for (k, v) in extra.as_object().expect("extra") {
            body[k] = v.clone();
        }
        body
    };
    rec.check("POST teams: no such project", &c.post("/projects/nope/ai/teams", made(json!({}))).await);
    rec.check("POST teams: name is a number", &c.post(&url, made(json!({"name": 5}))).await);
    rec.check("POST teams: max_parallel is text", &c.post(&url, made(json!({"max_parallel": "many"}))).await);
    rec.check("POST teams: config is a list", &c.post(&url, made(json!({"config": [1]}))).await);
    rec.check("POST teams: no body", &c.post_empty(&url).await);
    rec.check("POST teams: no name", &c.post(&url, json!({"working_dir": dir})).await);
    rec.check("POST teams: bad effort", &c.post(&url, made(json!({"effort": "extreme"}))).await);
    rec.check("POST teams: bad permission mode", &c.post(&url, made(json!({"permission_mode": "ask"}))).await);
    let team = c.post(&url, made(json!({"model": "haiku", "daily_budget": 5, "description": "Writes code"}))).await;
    rec.check("POST teams", &team);
    team.assert_status(201);
    let team = team.json();
    let tid = id(&team);
    rec.check("POST teams: same name", &c.post(&url, made(json!({"name": "dev an"}))).await);
    rec.check("POST teams: the name of a person", &c.post(&url, made(json!({"name": "An Nguyen"}))).await);
    rec.check("GET teams", &c.get(&url).await);
    rec.check("GET members has the team", &c.get(&format!("/projects/{pid}/members")).await);

    // read and edit
    let one = format!("/ai/teams/{tid}");
    rec.check("GET team", &c.get(&one).await);
    rec.check("GET team: not found", &c.get("/ai/teams/nope").await);
    rec.check("GET team: a person is no team", &c.get(&format!("/ai/teams/{an}")).await);
    rec.check("PATCH team: not found", &c.patch("/ai/teams/nope", json!({"effort": "high"})).await);
    rec.check("PATCH team: nothing", &c.patch(&one, json!({})).await);
    rec.check("PATCH team: no body", &c.request("PATCH", &one, &[], None).await);
    rec.check("PATCH team: effort is a list", &c.patch(&one, json!({"effort": ["high"]})).await);
    rec.check("PATCH team: bad effort", &c.patch(&one, json!({"effort": "extreme"})).await);
    rec.check("PATCH team: bad permission mode", &c.patch(&one, json!({"permission_mode": "ask"})).await);
    rec.check("PATCH team: empty name", &c.patch(&one, json!({"name": "  "})).await);
    rec.check(
        "PATCH team: roles",
        &c.patch(
            &one,
            json!({"pack_key": "feature_ui", "effort": "high", "permission_mode": "auto",
                   "config": {"roles": [{"key": "qa", "off": true}, {"key": "security", "model": "opus"}]}}),
        )
        .await,
    );
    rec.check("PATCH team: max_parallel as a whole float", &c.patch(&one, json!({"max_parallel": 3.0})).await);
    rec.check("PATCH team: max_parallel as a fraction", &c.patch(&one, json!({"max_parallel": 2.5})).await);
    rec.check("PATCH team: budget null", &c.patch(&one, json!({"daily_budget": null, "persona": "Careful."})).await);
    rec.check("PATCH team: unknown key is dropped", &c.patch(&one, json!({"colour": "red"})).await);

    // pause, resume, test
    rec.check("POST pause: not found", &c.post("/ai/teams/nope/pause", json!({})).await);
    rec.check("POST pause: no body", &c.post_empty(&format!("{one}/pause")).await);
    rec.check(
        "POST pause: cancel_current is text",
        &c.post(&format!("{one}/pause"), json!({"cancel_current": "x"})).await,
    );
    rec.check("POST pause", &c.post(&format!("{one}/pause"), json!({"reason": "lunch"})).await);
    rec.check("POST resume: not found", &c.post_empty("/ai/teams/nope/resume").await);
    rec.check("POST resume", &c.post_empty(&format!("{one}/resume")).await);
    rec.check("POST test: not found", &c.post_empty("/ai/teams/nope/test").await);
    rec.check("POST test", &c.post_empty(&format!("{one}/test")).await);
    let gone = tmp(&f).join("no-such").join("claude");
    rec.check("PATCH team: the runner is gone", &c.patch(&one, json!({"cli_path": gone.to_string_lossy()})).await);
    rec.check("POST test: the runner is gone", &c.post_empty(&format!("{one}/test")).await);
    rec.check("GET team: the runner is gone", &c.get(&one).await);

    // the account of the team
    let put = |m: &str| format!("/ai/teams/{m}/account");
    rec.check("PUT account: not found", &c.put(&put("nope"), json!({"account_id": null})).await);
    rec.check("PUT account: no body", &c.request("PUT", &put(&tid), &[], None).await);
    rec.check("PUT account: unknown account", &c.put(&put(&tid), json!({"account_id": "acct_nope"})).await);
    let a = account(c, "Work Claude").await;
    login(&a, "an@work.example");
    rec.check("PUT account", &c.put(&put(&tid), json!({"account_id": id(&a)})).await);
    rec.check("PUT account: null", &c.put(&put(&tid), json!({"account_id": null})).await);
    rec.check("PUT account: nothing sent", &c.put(&put(&tid), json!({})).await);

    // remove
    rec.check("GET removal-impact: not found", &c.get("/ai/teams/nope/removal-impact").await);
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{t1}"), json!({"assignee": tid})).await.assert_status(200);
    rec.check("GET removal-impact", &c.get(&format!("{one}/removal-impact")).await);
    rec.check("POST remove: not found", &c.post("/ai/teams/nope/remove", json!({})).await);
    rec.check("POST remove: bad tickets", &c.post(&format!("{one}/remove"), json!({"tickets": "drop"})).await);
    rec.check(
        "POST remove: reassign to nobody",
        &c.post(&format!("{one}/remove"), json!({"tickets": "reassign"})).await,
    );
    rec.check(
        "POST remove: reassign to a stranger",
        &c.post(&format!("{one}/remove"), json!({"tickets": "reassign", "reassign_to": "mem_nope"})).await,
    );
    rec.check(
        "POST remove: reassign",
        &c.post(&format!("{one}/remove"), json!({"tickets": "reassign", "reassign_to": an})).await,
    );
    rec.check("GET ticket after the removal", &c.get(&format!("/tickets/{t1}")).await);
    rec.check("GET teams after the removal", &c.get(&url).await);
    rec.check("GET teams: include_removed", &c.get(&format!("{url}?include_removed=true")).await);
    rec.check("GET teams: include_removed is text", &c.get(&format!("{url}?include_removed=maybe")).await);
    rec.check("POST remove: a removed team again", &c.post(&format!("{one}/remove"), json!({})).await);
    rec.check("PATCH team: a removed team", &c.patch(&one, json!({"effort": "low"})).await);
    rec.check("GET team: a removed team", &c.get(&one).await);
    // a second team, removed with the default (unassign)
    let second = make_team(&f, &pid, "Dev Binh", json!({})).await;
    let t2 = ticket(c, &pid, "Another", "todo").await;
    c.patch(&format!("/tickets/{t2}"), json!({"assignee": id(&second)})).await.assert_status(200);
    rec.check("POST remove: unassign", &c.post(&format!("/ai/teams/{}/remove", id(&second)), json!({})).await);
    rec.check("GET ticket after unassign", &c.get(&format!("/tickets/{t2}")).await);
    rec.finish();
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_routes() {
    let name = "settings_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    sign_in(&f);
    let mut rec = Rec::new("ai_team_routes", name, &[&tmp(&f)]);
    let (pid, _an) = project(c).await;
    let team = make_team(&f, &pid, "Dev An", json!({})).await;
    let url = format!("/projects/{pid}/ai/settings");
    rec.check("GET settings: no such project", &c.get("/projects/nope/ai/settings").await);
    rec.check("GET settings", &c.get(&url).await);
    rec.check("PATCH settings: no such project", &c.patch("/projects/nope/ai/settings", json!({})).await);
    rec.check("PATCH settings: no body", &c.request("PATCH", &url, &[], None).await);
    rec.check("PATCH settings: nothing", &c.patch(&url, json!({})).await);
    rec.check("PATCH settings: cap is text", &c.patch(&url, json!({"board_daily_cap": "lots"})).await);
    rec.check("PATCH settings: deny_list is text", &c.patch(&url, json!({"deny_list": "x"})).await);
    rec.check("PATCH settings: deny_list holds a number", &c.patch(&url, json!({"deny_list": [1]})).await);
    rec.check("PATCH settings: ops is a list", &c.patch(&url, json!({"ops": []})).await);
    rec.check("PATCH settings: permission mode", &c.patch(&url, json!({"permission_mode": "yolo"})).await);
    rec.check("PATCH settings: at the cap", &c.patch(&url, json!({"board_at_cap": "explode"})).await);
    rec.check("PATCH settings: lessons mode", &c.patch(&url, json!({"lessons_mode": "never"})).await);
    rec.check("PATCH settings: parallel null", &c.patch(&url, json!({"board_max_parallel": null})).await);
    rec.check("PATCH settings: memory null", &c.patch(&url, json!({"run_memory_limit_mb": null})).await);
    rec.check("PATCH settings: lessons_max null", &c.patch(&url, json!({"lessons_max": null})).await);
    rec.check("PATCH settings: permission_mode null", &c.patch(&url, json!({"permission_mode": null})).await);
    rec.check("PATCH settings: at_cap null", &c.patch(&url, json!({"board_at_cap": null})).await);
    rec.check(
        "PATCH settings",
        &c.patch(
            &url,
            json!({"deny_list": ["Bash(git push --force*)", " ", "  Read(.env)  "], "lessons_mode": "review",
                   "ops": {"live_messages": false, "nonsense": 1}, "board_daily_cap": 12.5,
                   "board_tokens_per_day": 1000, "board_max_parallel": 3, "board_runs_per_day": 20,
                   "board_monthly_budget": 100, "run_memory_limit_mb": 2048, "audit_retention_days": 30,
                   "lessons_max": 10, "board_at_cap": "stop", "permission_mode": "auto"}),
        )
        .await,
    );
    rec.check(
        "PATCH settings: limits null",
        &c.patch(&url, json!({"board_daily_cap": null, "audit_retention_days": null, "deny_list": null})).await,
    );
    rec.check("GET settings after", &c.get(&url).await);
    // pause-all and resume-all
    rec.check("POST pause-all: no such project", &c.post("/projects/nope/ai/pause-all", json!({})).await);
    rec.check("POST pause-all: no body", &c.post_empty(&format!("/projects/{pid}/ai/pause-all")).await);
    rec.check("POST pause-all", &c.post(&format!("/projects/{pid}/ai/pause-all"), json!({"reason": "stop"})).await);
    rec.check("GET overview paused", &c.get(&format!("/projects/{pid}/ai/overview")).await);
    rec.check("POST resume-all: no such project", &c.post_empty("/projects/nope/ai/resume-all").await);
    rec.check("POST resume-all", &c.post_empty(&format!("/projects/{pid}/ai/resume-all")).await);
    rec.check(
        "POST pause-all: default reason",
        &c.post(&format!("/projects/{pid}/ai/pause-all"), json!({"cancel_running": false})).await,
    );
    rec.check("POST resume-all again", &c.post_empty(&format!("/projects/{pid}/ai/resume-all")).await);
    // overview and board
    rec.check("GET overview: no such project", &c.get("/projects/nope/ai/overview").await);
    rec.check("GET overview", &c.get(&format!("/projects/{pid}/ai/overview")).await);
    rec.check("GET board: no such project", &c.get("/projects/nope/ai/board").await);
    rec.check("GET board", &c.get(&format!("/projects/{pid}/ai/board")).await);
    let _ = (team, &exec);
    rec.finish();
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

/// What a run holds that is a measurement, not behavior.
const MEASURED: [&str; 3] = ["pid", "peak_rss_mb", "last_rss_mb"];

#[tokio::test]
async fn run_routes() {
    let name = "run_routes";
    let Some(f) = start(name, true, &[("FAKE_CLAUDE_MODE", "v2")]).await else { return };
    let c = &f.c;
    sign_in(&f);
    let mut rec = Rec::new("ai_team_routes", name, &[&tmp(&f)]);
    rec.ignore(&MEASURED);
    let (pid, _an) = project(c).await;
    let t0 = ticket(c, &pid, "No team yet", "todo").await;
    rec.check("POST run: no team", &c.post(&format!("/tickets/{t0}/ai/run"), json!({})).await);
    let team = make_team(&f, &pid, "Dev An", json!({})).await;
    let team_id = id(&team);
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    let run_url = format!("/tickets/{t1}/ai/run");
    rec.check("POST run: no such ticket", &c.post("/tickets/nope/ai/run", json!({})).await);
    rec.check("POST run: bad mode", &c.post(&run_url, json!({"mode": "fly"})).await);
    rec.check("POST run: no body", &c.post_empty(&run_url).await);
    rec.check("POST run: instruction is a number", &c.post(&run_url, json!({"instruction": 3})).await);
    rec.check("POST run: unknown team", &c.post(&run_url, json!({"team_id": "mem_nope"})).await);
    let started = c.post(&run_url, json!({"instruction": "Fix add()", "team_id": team_id})).await;
    // the state of a run that has just been queued is a race with the scheduler's tick
    rec.check_hiding("POST run", &started, &["state", "started_at", "last_output_at", "live"]);
    started.assert_status(200);
    let finished = wait_run(c, &t1, &["finished", "failed"]).await;
    let rid = id(&finished);
    rec.note("the run ended as", json!({"state": finished["state"]}));
    rec.check("GET ticket runs", &c.get(&format!("/tickets/{t1}/ai/runs")).await);
    rec.check("GET ticket runs: limit 0", &c.get(&format!("/tickets/{t1}/ai/runs?limit=0")).await);
    rec.check("GET ticket runs: limit text", &c.get(&format!("/tickets/{t1}/ai/runs?limit=many")).await);
    rec.check("GET ticket runs: no such ticket", &c.get("/tickets/nope/ai/runs").await);
    let runs = format!("/projects/{pid}/ai/runs");
    rec.check("GET project runs", &c.get(&runs).await);
    rec.check("GET project runs: finished or failed", &c.get(&format!("{runs}?state=finished,failed")).await);
    rec.check("GET project runs: running", &c.get(&format!("{runs}?state=running")).await);
    rec.check("GET project runs: limit 1", &c.get(&format!("{runs}?limit=1")).await);
    rec.check("GET project runs: no such project", &c.get("/projects/nope/ai/runs").await);
    let one = format!("/ai/runs/{rid}");
    rec.check("GET run", &c.get(&one).await);
    rec.check("GET run: two steps", &c.get(&format!("{one}?steps=2")).await);
    rec.check("GET run: no steps", &c.get(&format!("{one}?steps=0")).await);
    rec.check("GET run: not found", &c.get("/ai/runs/nope").await);
    rec.check("GET steps", &c.get(&format!("{one}/steps")).await);
    rec.check("GET steps: after 1, limit 2", &c.get(&format!("{one}/steps?after=1&limit=2")).await);
    rec.check("GET steps: the lead", &c.get(&format!("{one}/steps?agent=lead")).await);
    rec.check("GET steps: an agent that is not there", &c.get(&format!("{one}/steps?agent=nope")).await);
    rec.check("GET steps: limit past the cap", &c.get(&format!("{one}/steps?limit=100000")).await);
    rec.check("GET steps: after is text", &c.get(&format!("{one}/steps?after=x")).await);
    rec.check("GET steps: not found", &c.get("/ai/runs/nope/steps").await);
    rec.check("GET step output", &c.get(&format!("{one}/steps/1/output")).await);
    rec.check("GET step output: no such step", &c.get(&format!("{one}/steps/99999/output")).await);
    rec.check("GET step output: no such run", &c.get("/ai/runs/nope/steps/1/output").await);
    rec.check("GET messages", &c.get(&format!("{one}/messages")).await);
    rec.check("GET messages: not found", &c.get("/ai/runs/nope/messages").await);
    // actions on a run that has ended
    rec.check("POST cancel: not found", &c.post_empty("/ai/runs/nope/cancel").await);
    rec.check("POST cancel: it has ended", &c.post_empty(&format!("{one}/cancel")).await);
    rec.check("POST restart: not found", &c.post_empty("/ai/runs/nope/restart").await);
    rec.check("POST restart: it has ended", &c.post_empty(&format!("{one}/restart")).await);
    rec.check("POST answer: not found", &c.post("/ai/runs/nope/answer", json!({"text": "x"})).await);
    rec.check("POST answer: no body", &c.post_empty(&format!("{one}/answer")).await);
    rec.check("POST answer: nothing asked", &c.post(&format!("{one}/answer"), json!({"text": "Yes"})).await);
    rec.check("POST answer: empty", &c.post(&format!("{one}/answer"), json!({})).await);
    rec.check("POST message: not found", &c.post("/ai/runs/nope/message", json!({"text": "x"})).await);
    rec.check("POST message: empty", &c.post(&format!("{one}/message"), json!({"text": "  "})).await);
    rec.check("POST message: no body", &c.post_empty(&format!("{one}/message")).await);
    rec.check("POST message", &c.post(&format!("{one}/message"), json!({"text": "Please add a test too."})).await);
    rec.check("GET messages after", &c.get(&format!("{one}/messages")).await);
    // the same ticket again
    rec.check("POST retry: not found", &c.post_empty("/ai/runs/nope/retry").await);
    let retry = c.post_empty(&format!("{one}/retry")).await;
    rec.check_hiding("POST retry", &retry, &["state", "started_at", "last_output_at", "live"]);
    let second = wait_run(c, &t1, &["finished", "failed"]).await;
    rec.check_hiding("POST retry: it ended", &c.get(&format!("/tickets/{t1}/ai/runs")).await, &["steps_count"]);
    let _ = second;
    // what the page of the project shows
    rec.check("GET board", &c.get(&format!("/projects/{pid}/ai/board")).await);
    rec.check("GET overview", &c.get(&format!("/projects/{pid}/ai/overview")).await);
    rec.check("GET live", &c.get(&format!("/projects/{pid}/ai/live")).await);
    rec.check("GET live: limit 0", &c.get(&format!("/projects/{pid}/ai/live?limit=0")).await);
    rec.check("GET live: no such project", &c.get("/projects/nope/ai/live").await);
    rec.check("GET resources", &c.get(&format!("/projects/{pid}/ai/resources")).await);
    rec.check("GET resources: no such project", &c.get("/projects/nope/ai/resources").await);
    rec.check("GET project activity", &c.get(&format!("/projects/{pid}/ai/team/activity")).await);
    rec.check("GET project activity: no such project", &c.get("/projects/nope/ai/team/activity").await);
    rec.check("GET team activity", &c.get(&format!("/ai/teams/{team_id}/activity")).await);
    rec.check("GET team activity: not found", &c.get("/ai/teams/nope/activity").await);
    let recent = format!("/projects/{pid}/ai/recent");
    rec.check("GET recent", &c.get(&recent).await);
    rec.check("GET recent: limit 0", &c.get(&format!("{recent}?limit=0")).await);
    rec.check("GET recent: one team", &c.get(&format!("{recent}?team_id={team_id}&limit=100")).await);
    rec.check("GET recent: another team", &c.get(&format!("{recent}?team_id=nope")).await);
    rec.check("GET recent: no such project", &c.get("/projects/nope/ai/recent").await);
    // sessions
    rec.check("GET sessions", &c.get(&format!("/tickets/{t1}/ai/sessions")).await);
    rec.check("POST compact: nothing to compact", &c.post_empty(&format!("/tickets/{t1}/ai/compact")).await);
    rec.check("POST compact: no such ticket", &c.post_empty("/tickets/nope/ai/compact").await);
    rec.check("POST sessions/new: no such ticket", &c.post_empty("/tickets/nope/ai/sessions/new").await);
    rec.check("POST sessions/new", &c.post_empty(&format!("/tickets/{t1}/ai/sessions/new")).await);
    rec.check("POST sessions/new: nothing to close", &c.post_empty(&format!("/tickets/{t1}/ai/sessions/new")).await);
    rec.check("GET sessions after", &c.get(&format!("/tickets/{t1}/ai/sessions")).await);
    rec.finish();
}
