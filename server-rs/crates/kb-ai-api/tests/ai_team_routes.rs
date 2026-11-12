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

use std::time::Duration;

use common::rec::Rec;
use common::{Fixture, account, exec, id, login, project, sign_in, start, ticket, tmp, wait_run};
use serde_json::{Value, json};

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
    let dir = common::repo(&f).to_string_lossy().into_owned();
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
    let team = c.post(&url, made(json!({"daily_budget": 5, "description": "Writes code"}))).await;
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
                   "config": {"roles": [{"key": "qa", "off": true}, {"key": "security", "model": "stand-in"}]}}),
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
    let second = common::runner(&f, &pid, "Dev Binh", json!({})).await;
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
    let team = common::runner(&f, &pid, "Dev An", json!({})).await;
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
const MEASURED: [&str; 6] = ["pid", "peak_rss_mb", "last_rss_mb", "steps_count", "files", "model"];

#[tokio::test]
async fn run_routes() {
    let name = "run_routes";
    let Some(f) = start(name, true, &[("FAKE_CLAUDE_MODE", "v2")]).await else { return };
    let c = &f.c;
    sign_in(&f);
    let mut rec = Rec::new("ai_team_routes", name, &[&tmp(&f)]);
    // the ids of the steps follow those of the steps the stand-in CLI's run wrote, and how many it wrote varies
    rec.ignore(&MEASURED);
    rec.ignore(&["id"]);
    let (pid, _an) = project(c).await;
    let t0 = ticket(c, &pid, "No team yet", "todo").await;
    rec.check("POST run: no team", &c.post(&format!("/tickets/{t0}/ai/run"), json!({})).await);
    let team = common::runner(&f, &pid, "Dev An", json!({})).await;
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
    let real = id(&finished);
    rec.note("the run ended as", json!({"state": finished["state"]}));
    rec.check("GET ticket runs", &c.get(&format!("/tickets/{t1}/ai/runs")).await);
    rec.check("GET ticket runs: limit 0", &c.get(&format!("/tickets/{t1}/ai/runs?limit=0")).await);
    rec.check("GET ticket runs: limit text", &c.get(&format!("/tickets/{t1}/ai/runs?limit=many")).await);
    rec.check("GET ticket runs: no such ticket", &c.get("/tickets/nope/ai/runs").await);
    // what a run writes is a matter of timing (the stand-in CLI's lines and the hooks race), so the steps are read
    // from a run the test writes itself: four steps of the lead, one of a role, an output, two notes
    let t2 = ticket(c, &pid, "Written by hand", "todo").await;
    let rid = common::run(&f.server, &pid, &team_id, &t2, "finished", None).await;
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string();
    exec(
        &f.server,
        "UPDATE ai_run SET steps_count = 5, started_at = ?, ended_at = ?, queued_at = ?, last_output_at = ?, \
         summary = ?, question = ? WHERE id = ?",
        &[
            json!(now),
            json!(now),
            json!(now),
            json!(now),
            json!("Fixed add()."),
            json!("{\"text\": \"Which database?\"}"),
            json!(rid),
        ],
    )
    .await;
    common::insert(
        &f.server,
        "ai_run_agent",
        &json!({"id": "agent1", "run_id": rid, "agent_type": "reviewer", "started_at": now, "ended_at": now,
                "steps_count": 1, "last_text": "Looks good."}),
    )
    .await;
    let steps = [
        (
            1,
            Value::Null,
            "edit",
            "Edit",
            "Edited calc.py",
            json!({"path": "calc.py", "added": 1, "removed": 1}),
            Value::Null,
        ),
        (
            2,
            Value::Null,
            "command",
            "Bash",
            "Ran pytest -q",
            json!({"command": "pytest -q", "exit_code": 0}),
            json!("4 passed\n"),
        ),
        (3, Value::Null, "text", "", "Done.", json!({}), Value::Null),
        (4, json!("agent1"), "text", "", "Looks good.", json!({}), Value::Null),
        (5, Value::Null, "end", "", "Finished", json!({}), Value::Null),
    ];
    for (seq, agent, kind, tool, title, detail, output) in steps {
        common::insert(
            &f.server,
            "ai_run_step",
            &json!({"run_id": rid, "seq": seq, "at": now, "agent_id": agent, "kind": kind, "tool": tool,
                    "title": title, "detail": detail.to_string(), "output": output}),
        )
        .await;
    }
    for (n, direction, text) in [(1, "in", "Please add a test."), (2, "out", "Added.")] {
        common::insert(
            &f.server,
            "ai_run_message",
            &json!({"id": format!("msg_{n:012x}"), "run_id": rid, "direction": direction, "peer": "user",
                    "text": text, "at": now}),
        )
        .await;
    }
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
    rec.check("GET run: steps is text", &c.get(&format!("{one}?steps=all")).await);
    rec.check("GET run: not found", &c.get("/ai/runs/nope").await);
    rec.check("GET steps", &c.get(&format!("{one}/steps")).await);
    rec.check("GET steps: after 1, limit 2", &c.get(&format!("{one}/steps?after=1&limit=2")).await);
    rec.check("GET steps: the lead", &c.get(&format!("{one}/steps?agent=lead")).await);
    rec.check("GET steps: a role", &c.get(&format!("{one}/steps?agent=agent1")).await);
    rec.check("GET steps: an agent that is not there", &c.get(&format!("{one}/steps?agent=nope")).await);
    rec.check("GET steps: limit past the cap", &c.get(&format!("{one}/steps?limit=100000")).await);
    rec.check("GET steps: after is text", &c.get(&format!("{one}/steps?after=x")).await);
    rec.check("GET steps: not found", &c.get("/ai/runs/nope/steps").await);
    rec.check("GET step output", &c.get(&format!("{one}/steps/2/output")).await);
    rec.check("GET step output: a step with none", &c.get(&format!("{one}/steps/1/output")).await);
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
    // the same ticket again
    rec.check("POST retry: not found", &c.post_empty("/ai/runs/nope/retry").await);
    let retry = c.post_empty(&format!("/ai/runs/{real}/retry")).await;
    rec.check_hiding("POST retry", &retry, &["state", "started_at", "last_output_at", "live"]);
    wait_run(c, &t1, &["finished", "failed"]).await;
    rec.check(
        "POST message",
        &c.post(&format!("/ai/runs/{real}/message"), json!({"text": "Please add a test too."})).await,
    );
    // a note to a run that has ended starts a new run on the ticket
    wait_run(c, &t1, &["finished", "failed"]).await;
    rec.check("GET messages after", &c.get(&format!("/ai/runs/{real}/messages")).await);
    rec.check("GET ticket runs after the retry", &c.get(&format!("/tickets/{t1}/ai/runs")).await);
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

/// A run the test writes itself (what a run writes is a matter of timing, so the pages that show runs are read from
/// runs whose rows are known): `at` is the minute it started, counted back from now.
#[allow(clippy::too_many_arguments)]
async fn hand_run(
    f: &Fixture,
    pid: &str,
    team: &str,
    ticket_id: &str,
    number: i64,
    state: &str,
    trigger: &str,
    started_by: &str,
    minutes_ago: i64,
    lasted: Option<i64>,
) -> String {
    let at = |minutes: i64| {
        (chrono::Utc::now() - chrono::Duration::minutes(minutes)).format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    };
    let run_id = format!("run_{}", common::unique());
    let ended = lasted.map(|m| at(minutes_ago - m));
    common::insert(
        &f.server,
        "ai_run",
        &json!({
            "id": run_id, "project_id": pid, "kind": "team", "ticket_id": ticket_id, "member_id": team,
            "number": number, "mode": "work", "trigger": trigger, "state": state, "started_by": started_by,
            "instruction": "Fix add()", "queued_at": at(minutes_ago), "started_at": at(minutes_ago),
            "ended_at": ended, "last_output_at": at(minutes_ago - lasted.unwrap_or(1)),
            "summary": if state == "finished" { json!("Fixed add(); tests pass.") } else { Value::Null },
            "report": "{}", "files": "[]", "tokens_in": 100, "tokens_out": 50, "cost_usd": 0.02, "metered": false,
            "paused": false, "restarts": "[]", "retries": "[]", "steps_count": 3, "live": false, "depth": 0,
        }),
    )
    .await;
    for (seq, kind, tool, title, detail) in [
        (1, "edit", "Edit", "Edited calc.py", json!({"path": "calc.py", "added": 1, "removed": 1})),
        (2, "command", "Bash", "Ran pytest -q", json!({"command": "pytest -q", "exit_code": 0})),
        (3, "text", "", "Done.", json!({})),
    ] {
        common::insert(
            &f.server,
            "ai_run_step",
            &json!({"run_id": run_id, "seq": seq, "at": at(minutes_ago - seq), "kind": kind, "tool": tool,
                    "title": title, "detail": detail.to_string()}),
        )
        .await;
    }
    run_id
}

/// The pages of the project (the board's chips, the overview, the live panel, activity, the Timeline, the Flow map,
/// "You stepped in" and Health) over runs the test writes itself: a run a person started, a retry that failed, a run
/// that is going, and a run that waits for an answer.
#[tokio::test]
async fn page_routes() {
    let name = "page_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    sign_in(&f);
    let mut rec = Rec::new("ai_team_routes", name, &[&tmp(&f)]);
    // how long a run has been going, and the buckets of the window that its minutes fall into, move with the clock
    rec.ignore(&["elapsed_s", "density"]);
    let (pid, _an) = project(c).await;
    let other = c.post("/projects", json!({"name": "Other", "prefix": "OTH", "color": "#2E6F40"})).await;
    other.assert_status(201);
    let pid2 = id(&other.json());
    let team = common::runner(&f, &pid, "Dev An", json!({})).await;
    let team_id = id(&team);
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    let t2 = ticket(c, &pid, "Write the docs", "todo").await;
    let first = hand_run(&f, &pid, &team_id, &t1, 1, "finished", "run_button", "An Nguyen", 50, Some(5)).await;
    let retry = hand_run(&f, &pid, &team_id, &t1, 2, "failed", "retry", "An Nguyen", 30, Some(2)).await;
    let _going = hand_run(&f, &pid, &team_id, &t2, 1, "running", "assign", "user", 10, None).await;
    let asking = hand_run(&f, &pid, &team_id, &t2, 2, "needs_input", "assign", "user", 4, None).await;
    exec(
        &f.server,
        "UPDATE ai_run SET question = ? WHERE id = ?",
        &[json!("{\"text\": \"Which database?\"}"), json!(asking)],
    )
    .await;
    common::insert(
        &f.server,
        "ai_run_message",
        &json!({"id": "msg_000000000001", "run_id": first, "direction": "in", "peer": "An Nguyen",
                "text": "Please add a test.", "at": (chrono::Utc::now() - chrono::Duration::minutes(48)).format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()}),
    )
    .await;
    // what the page of the project shows
    rec.check("GET board", &c.get(&format!("/projects/{pid}/ai/board")).await);
    rec.check("GET overview", &c.get(&format!("/projects/{pid}/ai/overview")).await);
    rec.check("GET live", &c.get(&format!("/projects/{pid}/ai/live")).await);
    rec.check("GET live: limit 0", &c.get(&format!("/projects/{pid}/ai/live?limit=0")).await);
    rec.check("GET live: no such project", &c.get("/projects/nope/ai/live").await);
    rec.check_hiding(
        "GET resources",
        &c.get(&format!("/projects/{pid}/ai/resources")).await,
        &["machine", "cli_rss_mb", "at"],
    );
    rec.check("GET resources: no such project", &c.get("/projects/nope/ai/resources").await);
    rec.check_hiding("GET project activity", &c.get(&format!("/projects/{pid}/ai/team/activity")).await, &["day"]);
    rec.check("GET project activity: no such project", &c.get("/projects/nope/ai/team/activity").await);
    rec.check_hiding("GET team activity", &c.get(&format!("/ai/teams/{team_id}/activity")).await, &["day"]);
    rec.check("GET team activity: not found", &c.get("/ai/teams/nope/activity").await);
    let recent = format!("/projects/{pid}/ai/recent");
    rec.check("GET recent", &c.get(&recent).await);
    rec.check("GET recent: limit 0", &c.get(&format!("{recent}?limit=0")).await);
    rec.check("GET recent: one team", &c.get(&format!("{recent}?team_id={team_id}&limit=100")).await);
    rec.check("GET recent: another team", &c.get(&format!("{recent}?team_id=nope")).await);
    rec.check("GET recent: no such project", &c.get("/projects/nope/ai/recent").await);
    // the Timeline, the Flow map, "You stepped in" and Health
    let timeline = format!("/projects/{pid}/ai/team/timeline");
    rec.check("GET timeline", &c.get(&timeline).await);
    for range in ["hour", "24h", "7d", "forever"] {
        rec.check(&format!("GET timeline: {range}"), &c.get(&format!("{timeline}?range={range}")).await);
    }
    rec.check("GET timeline: one ticket", &c.get(&format!("{timeline}?ticket_id={t1}")).await);
    rec.check("GET timeline: one team", &c.get(&format!("{timeline}?team_id={team_id}&range=24h")).await);
    rec.check("GET timeline: another team", &c.get(&format!("{timeline}?team_id=nope&range=24h")).await);
    rec.check(
        "GET timeline: a window",
        &c.get(&format!("{timeline}?since=2020-01-01T00:00:00Z&until=2020-01-02T00:00:00%2B02:00")).await,
    );
    rec.check("GET timeline: since is text", &c.get(&format!("{timeline}?since=yesterday")).await);
    rec.check("GET timeline: until is empty", &c.get(&format!("{timeline}?until=")).await);
    rec.check("GET timeline: no such project", &c.get("/projects/nope/ai/team/timeline").await);
    let flow = format!("/projects/{pid}/ai/team/flow");
    rec.check("GET flow", &c.get(&flow).await);
    for range in ["hour", "24h", "7d", "all", "forever"] {
        rec.check(&format!("GET flow: {range}"), &c.get(&format!("{flow}?range={range}")).await);
    }
    rec.check("GET flow: one ticket", &c.get(&format!("{flow}?ticket_id={t1}&range=all")).await);
    rec.check("GET flow: one team", &c.get(&format!("{flow}?team_id={team_id}&range=all")).await);
    rec.check("GET flow: a window", &c.get(&format!("{flow}?since=2020-01-01T00:00:00Z")).await);
    rec.check("GET flow: until is text", &c.get(&format!("{flow}?until=tomorrow")).await);
    rec.check("GET flow: no such project", &c.get("/projects/nope/ai/team/flow").await);
    rec.check("GET flow scopes", &c.get(&format!("{flow}/scopes")).await);
    rec.check("GET flow scopes: no such project", &c.get("/projects/nope/ai/team/flow/scopes").await);
    let touches = format!("/projects/{pid}/ai/team/touches");
    rec.check("GET touches", &c.get(&touches).await);
    for query in ["range=24h", "range=30d", "range=forever", "kind=edit", "mark=needed", "mark=avoidable", "kind=nope"]
    {
        rec.check(&format!("GET touches: {query}"), &c.get(&format!("{touches}?{query}")).await);
    }
    rec.check("GET touches: one team", &c.get(&format!("{touches}?team_id={team_id}")).await);
    rec.check("GET touches: no such project", &c.get("/projects/nope/ai/team/touches").await);
    rec.check("PUT mark: no such project", &c.put("/projects/nope/ai/team/touches/mark", json!({"key": "k"})).await);
    rec.check("PUT mark: no key", &c.put(&format!("{touches}/mark"), json!({})).await);
    rec.check(
        "PUT mark: a mark that is not one",
        &c.put(&format!("{touches}/mark"), json!({"key": "k", "mark": "maybe"})).await,
    );
    rec.check(
        "PUT mark: no such touch",
        &c.put(&format!("{touches}/mark"), json!({"key": "nope", "mark": "needed"})).await,
    );
    let touch = format!("run:{first}");
    let marks = format!("{touches}/mark");
    rec.check("PUT mark: needed", &c.put(&marks, json!({"key": touch, "mark": "needed"})).await);
    rec.check("POST lesson: not avoidable", &c.post(&format!("{touches}/lesson"), json!({"key": touch})).await);
    rec.check("PUT mark: avoidable", &c.put(&marks, json!({"key": touch, "mark": "avoidable"})).await);
    rec.check("GET touches: marked", &c.get(&format!("{touches}?mark=avoidable")).await);
    rec.check(
        "PUT mark: another project",
        &c.put(&format!("/projects/{pid2}/ai/team/touches/mark"), json!({"key": touch, "mark": "needed"})).await,
    );
    rec.check(
        "POST lesson: too long",
        &c.post(&format!("{touches}/lesson"), json!({"key": touch, "text": "x".repeat(700)})).await,
    );
    rec.check(
        "POST lesson",
        &c.post(&format!("{touches}/lesson"), json!({"key": touch, "text": "Say which database in the ticket."})).await,
    );
    rec.check("POST lesson: again", &c.post(&format!("{touches}/lesson"), json!({"key": touch})).await);
    rec.check("PUT mark: take it away", &c.put(&marks, json!({"key": touch, "mark": null})).await);
    let retried = format!("retry:{retry}");
    rec.check("PUT mark: a retry", &c.put(&marks, json!({"key": retried, "mark": "avoidable"})).await);
    rec.check(
        "POST lesson: from a retry, a draft",
        &c.post(&format!("{touches}/lesson"), json!({"key": retried})).await,
    );
    rec.check("GET touches: after", &c.get(&touches).await);
    rec.check(
        "POST lesson: no such project",
        &c.post("/projects/nope/ai/team/touches/lesson", json!({"key": "k"})).await,
    );
    rec.check("POST lesson: no key", &c.post(&format!("{touches}/lesson"), json!({})).await);
    rec.check("POST lesson: no such touch", &c.post(&format!("{touches}/lesson"), json!({"key": "nope"})).await);
    let health = format!("/projects/{pid}/ai/team/health");
    rec.check("GET health", &c.get(&health).await);
    rec.check("GET health: 30d", &c.get(&format!("{health}?range=30d")).await);
    rec.check("GET health: 3d", &c.get(&format!("{health}?range=3d")).await);
    rec.check("GET health: no such project", &c.get("/projects/nope/ai/team/health").await);
    rec.finish();
}

// ---------------------------------------------------------------------------
// runs in flight
// ---------------------------------------------------------------------------

/// A lead that asks a question and waits: what a person does with a run that needs an answer.
#[tokio::test]
async fn asking_run_routes() {
    let name = "asking_run_routes";
    let fake = [("FAKE_CLAUDE_MODE", "v2_ask"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"), ("FAKE_CLAUDE_WAIT", "3")];
    let Some(f) = start(name, true, &fake).await else { return };
    let c = &f.c;
    sign_in(&f);
    let mut rec = Rec::new("ai_team_routes", name, &[&tmp(&f)]);
    rec.ignore(&MEASURED);
    rec.ignore(&["id", "steps", "agents", "cost_usd", "tokens_in", "tokens_out", "context_used", "context_window"]);
    let (pid, _an) = project(c).await;
    let team = common::runner(&f, &pid, "Dev An", json!({})).await;
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    c.post(&format!("/tickets/{t1}/ai/run"), json!({})).await.assert_status(200);
    let asking = wait_run(c, &t1, &["needs_input", "failed", "finished"]).await;
    rec.note("the run waits as", json!({"state": asking["state"]}));
    let rid = id(&asking);
    let one = format!("/ai/runs/{rid}");
    rec.check("GET run: asking", &c.get(&one).await);
    rec.check("GET overview: a run waits", &c.get(&format!("/projects/{pid}/ai/overview")).await);
    rec.check("GET board: a question", &c.get(&format!("/projects/{pid}/ai/board")).await);
    rec.check("GET live: asking", &c.get(&format!("/projects/{pid}/ai/live")).await);
    rec.check("GET team: with a run waiting", &c.get(&format!("/ai/teams/{}", id(&team))).await);
    rec.check(
        "POST run: a lead is already on the ticket",
        &c.post(&format!("/tickets/{t1}/ai/run"), json!({"instruction": "Use SQLite"})).await,
    );
    rec.check("POST restart: it waits for an answer", &c.post_empty(&format!("{one}/restart")).await);
    rec.check("POST retry: it has not ended", &c.post_empty(&format!("{one}/retry")).await);
    rec.check("POST answer", &c.post(&format!("{one}/answer"), json!({"text": "PostgreSQL"})).await);
    let asked = wait_run(c, &t1, &["needs_input", "failed", "finished"]).await;
    rec.note("the run then waits as", json!({"state": asked["state"]}));
    rec.check("GET messages: the answer", &c.get(&format!("{one}/messages")).await);
    rec.check("POST cancel", &c.post_empty(&format!("{one}/cancel")).await);
    rec.check("POST cancel: again", &c.post_empty(&format!("{one}/cancel")).await);
    rec.check("GET run: cancelled", &c.get(&one).await);
    rec.check("GET overview: nothing waits", &c.get(&format!("/projects/{pid}/ai/overview")).await);
    rec.check("POST retry: a cancelled run", &c.post_empty(&format!("{one}/retry")).await);
    rec.finish();
}

/// A lead that works and waits for a note: restart, a note into the live run, stopping it with the team's pause and
/// with the project's kill switch.
#[tokio::test]
async fn running_run_routes() {
    let name = "running_run_routes";
    let fake = [("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"), ("FAKE_CLAUDE_WAIT", "60")];
    let Some(f) = start(name, true, &fake).await else { return };
    let c = &f.c;
    sign_in(&f);
    let mut rec = Rec::new("ai_team_routes", name, &[&tmp(&f)]);
    rec.ignore(&MEASURED);
    rec.ignore(&[
        "id",
        "steps",
        "agents",
        "cost_usd",
        "tokens_in",
        "tokens_out",
        "context_used",
        "context_window",
        "rss_mb",
        "history",
    ]);
    let (pid, _an) = project(c).await;
    let team = common::runner(&f, &pid, "Dev An", json!({})).await;
    let team_id = id(&team);
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    c.post(&format!("/tickets/{t1}/ai/run"), json!({})).await.assert_status(200);
    let running = wait_run(c, &t1, &["running", "failed", "finished"]).await;
    rec.note("the run is", json!({"state": running["state"]}));
    let rid = id(&running);
    let one = format!("/ai/runs/{rid}");
    // the lead has written its first lines and waits for a note
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let steps = c.get(&format!("{one}/steps")).await.json();
        if steps.as_array().is_some_and(|s| s.iter().any(|x| x["kind"] == "text")) {
            break;
        }
        assert!(tokio::time::Instant::now() < end, "the lead wrote nothing");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    rec.check("GET run: running", &c.get(&one).await);
    rec.check("GET overview: running", &c.get(&format!("/projects/{pid}/ai/overview")).await);
    rec.check("GET live: running", &c.get(&format!("/projects/{pid}/ai/live")).await);
    rec.check_hiding(
        "GET resources: running",
        &c.get(&format!("/projects/{pid}/ai/resources")).await,
        &["machine", "cli_rss_mb", "at", "uptime_s", "age_s"],
    );
    rec.check("POST retry: it has not ended", &c.post_empty(&format!("{one}/retry")).await);
    rec.check("POST answer: nothing asked", &c.post(&format!("{one}/answer"), json!({"text": "Yes"})).await);
    rec.check("POST restart", &c.post_empty(&format!("{one}/restart")).await);
    // the CLI starts again inside the same run
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let run = c.get(&one).await.json();
        if run["state"] == "running" && run["restarts"].as_array().is_some_and(|r| !r.is_empty()) {
            break;
        }
        assert!(tokio::time::Instant::now() < end, "the run never came back: {}", run["state"]);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    rec.check("GET run: restarted", &c.get(&one).await);
    // pausing the team with its current run
    rec.check(
        "POST pause: cancel the current run",
        &c.post(&format!("/ai/teams/{team_id}/pause"), json!({"cancel_current": true, "reason": "lunch"})).await,
    );
    let cancelled = wait_run(c, &t1, &["cancelled", "failed", "finished"]).await;
    rec.note("the run after the pause is", json!({"state": cancelled["state"], "reason": cancelled["ended_reason"]}));
    rec.check("GET team: paused", &c.get(&format!("/ai/teams/{team_id}")).await);
    rec.check("POST run: a paused team", &c.post(&format!("/tickets/{t1}/ai/run"), json!({})).await);
    // (the team starts the run that waited as soon as it is resumed: its slots are a race, only that it is on is not)
    let resumed = c.post_empty(&format!("/ai/teams/{team_id}/resume")).await;
    rec.note("POST resume", json!({"status": resumed.status, "paused": resumed.json()["paused"]}));
    // the kill switch (the run that waited behind the pause started when the team was resumed)
    let again = c.get(&format!("/tickets/{t1}/ai/runs")).await.json();
    let again = id(&again[0]);
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let run = c.get(&format!("/ai/runs/{again}")).await.json();
        if run["state"] == "running" {
            break;
        }
        assert!(tokio::time::Instant::now() < end, "the run never started: {}", run["state"]);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    rec.check(
        "POST pause-all: cancels what runs",
        &c.post(&format!("/projects/{pid}/ai/pause-all"), json!({"reason": "freeze"})).await,
    );
    let stopped = wait_run(c, &t1, &["cancelled", "failed", "finished"]).await;
    rec.note("the run after the kill switch is", json!({"state": stopped["state"], "reason": stopped["ended_reason"]}));
    rec.check("GET run: stopped by the kill switch", &c.get(&format!("/ai/runs/{again}")).await);
    rec.check("POST run: everything is paused", &c.post(&format!("/tickets/{t1}/ai/run"), json!({})).await);
    rec.check("POST resume-all", &c.post_empty(&format!("/projects/{pid}/ai/resume-all")).await);
    // a note into a live run: the stand-in lead hears it and finishes
    // (the run that waited behind the kill switch starts when it is lifted)
    let last = c.get(&format!("/tickets/{t1}/ai/runs")).await.json();
    let last = id(&last[0]);
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let steps = c.get(&format!("/ai/runs/{last}/steps")).await.json();
        let run = c.get(&format!("/ai/runs/{last}")).await.json();
        if run["state"] == "running" && steps.as_array().is_some_and(|s| s.iter().any(|x| x["kind"] == "text")) {
            break;
        }
        assert!(tokio::time::Instant::now() < end, "the last run never worked: {}", run["state"]);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    rec.check(
        "POST message: into the live run",
        &c.post(&format!("/ai/runs/{last}/message"), json!({"text": "Use pytest."})).await,
    );
    let ended = wait_run(c, &t1, &["finished", "failed", "cancelled"]).await;
    rec.note("the run after the note is", json!({"state": ended["state"]}));
    rec.check("GET touches: what the person did", &c.get(&format!("/projects/{pid}/ai/team/touches")).await);
    rec.finish();
}
