//! AI v2 teams: making, editing, pausing and removing a team; the team check (`tests/test_ai_teams.py`).
//!
//! The Python tests go through the team routes (`api/ai.py`, a later task). Each route does little more than call
//! `teams`, so the tests are ported at service level with the same names and assertions: `team_of` is `POST
//! /projects/{id}/ai/teams` (`create`, `test_connection`, `describe`), `described` is `GET /ai/teams/{id}`, a 422 is a
//! `teams::Error::Team`. Not ported: `test_settings_pause_all_and_overview` (the settings, pause-all, overview and
//! board routes are code of the router itself; its one `teams` assertion, the `paused_all` status, is in
//! `golden_teams.rs`). `test_roles_become_agents_json_and_markdown` and `test_every_team_pack_resolves_to_known_roles`
//! are in `crates/kb-ai-know/tests/test_ai_teams.rs`.
//!
//! After the ported tests: what the Python suite covers only through whole runs, here against a `seams::Runs` that
//! records the calls (pausing with "cancel the current run", removing a team with runs in flight) and `health_check`.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use kb_ai_run::seams::{self, CancelError};
use kb_ai_run::teams::{self, Error};
use kb_board::tickets::{TicketUpdate, update_ticket};
use kb_db::database;
use kb_db::entities::{ai_team, member, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};
use tower::ServiceExt;

fn body(value: Value) -> Map<String, Value> {
    value.as_object().expect("a body").clone()
}

fn refusal<T: std::fmt::Debug>(result: Result<T, Error>) -> String {
    match result {
        Err(Error::Team(message)) => message,
        other => panic!("not refused: {other:?}"),
    }
}

/// `POST path` with a JSON body through the board's own router, in this process.
async fn post(path: &str, body: Value) -> (StatusCode, Value) {
    let (router, _table) = kb_board::api::routes().into_parts();
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("a request");
    let response = router.oneshot(request).await.expect("the router answers");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.expect("the body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn test_a_team_is_made_with_its_pack_and_checked() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Dev An", json!({})).await;
    assert_eq!(team["name"], "Dev An");
    assert_eq!(team["kind"], "ai");
    assert_eq!(team["pack_key"], "standard");
    let keys: Vec<&str> =
        team["roles"].as_array().expect("roles").iter().map(|r| r["key"].as_str().expect("key")).collect();
    assert_eq!(keys, ["dev", "reviewer", "qa"]);
    assert_eq!(team["permission_mode"], "bypass");
    assert_eq!(team["model"], "haiku");
    assert!(["idle", "runner_missing", "not_logged_in"].contains(&team["status"]["code"].as_str().expect("code")));
    // the fake CLI answers `auth status` as signed in: the runner is found
    assert_eq!(team["health"], "ok", "{}", team["health_detail"]);
    let session = database::session();
    let listed = teams::list_teams(&session, &pid, false).await.expect("list");
    assert_eq!(listed.iter().map(|t| t["id"].clone()).collect::<Vec<_>>(), [team["id"].clone()]);
    // the team is a member of the project too: it can be the assignee and the comment author
    let members = kb_board::members::list_members(&session, &pid).await.expect("members");
    assert!(members.iter().any(|m| json!(m.id) == team["id"] && m.kind == "ai"));
}

#[tokio::test]
async fn test_names_are_unique_across_people_and_teams() {
    let _guard = common::init().await;
    kb_ai_run::register();
    let (pid, _an) = common::project().await;
    common::team_of(&pid, "Dev An", json!({})).await;
    let session = database::session();
    let repo = common::tmp_path("repo");
    let data =
        |name: &str| body(json!({"name": name, "working_dir": repo.to_string_lossy(), "cli_path": common::real_cli()}));
    let detail = refusal(teams::create(&session, &pid, &data("dev an"), "user").await);
    assert!(detail.contains("Dev An 2") || detail.contains("already"), "{detail}");
    refusal(teams::create(&session, &pid, &data("An Nguyen"), "user").await);
    // a person cannot take a team's name either: the board's own route asks `teams.check_name` through its hook
    let (status, _) = post(&format!("/projects/{pid}/members"), json!({"name": "Dev An"})).await;
    assert!(status == StatusCode::CONFLICT || status == StatusCode::UNPROCESSABLE_ENTITY, "{status}");
}

#[tokio::test]
async fn test_edit_pack_roles_and_settings() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let id = team["id"].as_str().expect("id");
    let session = database::session();
    let patch = body(json!({
        "pack_key": "feature_ui",
        "effort": "high",
        "permission_mode": "auto",
        "config": {"roles": [{"key": "qa", "off": true}, {"key": "security", "model": "opus"}]},
    }));
    teams::update(&session, id, &patch, "user").await.expect("update");
    let out = common::described(id).await;
    let roles = out["roles"].as_array().expect("roles");
    let keys: Vec<&str> = roles.iter().map(|x| x["key"].as_str().expect("key")).collect();
    assert!(!keys.contains(&"qa") && keys.last() == Some(&"security"), "{keys:?}");
    assert_eq!(roles.iter().find(|x| x["key"] == "security").expect("security")["model"], "opus");
    assert!(out["effort"] == "high" && out["permission_mode"] == "auto");
    refusal(teams::update(&session, id, &body(json!({"effort": "extreme"})), "user").await);
    refusal(teams::update(&session, id, &body(json!({"permission_mode": "ask"})), "user").await);
}

#[tokio::test]
async fn test_pause_resume_and_remove_unassign_the_tickets() {
    let _guard = common::init().await;
    let (pid, an) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let session = database::session();
    update_ticket(&session, &tid, &TicketUpdate::of("assignee", json!(id))).await.expect("assign");
    teams::set_paused(&session, id, true, "user", false, Some("lunch")).await.expect("pause");
    let r = common::described(id).await;
    assert!(r["paused"] == true && r["status"]["code"] == "paused");
    assert_eq!(r["status"]["detail"], "lunch");
    teams::set_paused(&session, id, false, "user", false, None).await.expect("resume");
    assert_eq!(common::described(id).await["paused"], false);
    let impact = teams::removal_impact(&session, id).await.expect("impact");
    assert_eq!(
        impact["open_tickets"].as_array().expect("tickets").iter().map(|t| t["id"].clone()).collect::<Vec<_>>(),
        [json!(tid)]
    );
    let removed = teams::remove(&session, id, "user", "reassign", Some(&an)).await.expect("remove");
    assert_eq!(Value::Object(removed), json!({"removed": true}));
    let stored = ticket::Entity::find_by_id(tid.as_str()).one(&session).await.expect("db").expect("ticket");
    assert_eq!(stored.assignee.as_deref(), Some(an.as_str()));
    assert!(teams::list_teams(&session, &pid, false).await.expect("list").is_empty());
    let removed = teams::list_teams(&session, &pid, true).await.expect("list");
    assert_eq!(removed[0]["kind"], "ai_removed");
    assert_eq!(removed[0]["status"]["code"], "removed");
}

/// The UI reads `ok` and `message` of POST /ai/teams/{id}/test (it said "check failed" for a healthy team).
#[tokio::test]
async fn test_the_check_says_ok_and_why() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let id = team["id"].as_str().expect("id");
    let session = database::session();
    let r = teams::test_connection(&session, id).await.expect("test");
    assert!(r["ok"] == true && r["health"] == "ok" && r["message"].as_str().expect("message").contains("Claude Code"));
    let gone = common::tmp_path("gone").join("no-such").join("claude");
    teams::update(&session, id, &body(json!({"cli_path": gone.to_string_lossy()})), "user").await.expect("update");
    // a new CLI path: the team is not known to be healthy until it is checked again
    assert_eq!(common::described(id).await["health"], "unknown");
    let r = teams::test_connection(&session, id).await.expect("test");
    assert!(r["ok"] == false && r["health"] == "runner_missing" && r["message"] == r["health_detail"], "{r:?}");
    assert!(r["message"].as_str().expect("message").contains("it is not a file"));
}

// ---------------------------------------------------------------------------------------------------------------
// beside the Python tests: the runs seam, removing, the health check
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn remove_refuses_a_target_that_is_not_a_person_of_the_project_and_unassigns_by_default() {
    let _guard = common::init().await;
    let (pid, an) = common::project().await;
    let (other_pid, other_an) = common::project().await;
    let team = common::team_of(&pid, "Dev An", json!({})).await;
    let second = common::team_of(&pid, "Dev Binh", json!({})).await;
    let id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let done = common::ticket(&pid, "Done", "done").await.id;
    let session = database::session();
    for t in [&tid, &done] {
        update_ticket(&session, t, &TicketUpdate::of("assignee", json!(id))).await.expect("assign");
    }
    for target in [None, Some(other_an.as_str()), Some(second["id"].as_str().expect("id")), Some("no-such")] {
        let message = refusal(teams::remove(&session, id, "An Nguyen", "reassign", target).await);
        assert_eq!(message, "Pick a person to reassign the tickets to.");
    }
    assert_eq!(refusal(teams::remove(&session, &an, "An Nguyen", "unassign", None).await), "AI team not found.");
    assert_eq!(refusal(teams::remove(&session, "no-such", "An Nguyen", "unassign", None).await), "AI team not found.");
    let _ = other_pid;
    teams::remove(&session, id, "An Nguyen", "unassign", Some(&an)).await.expect("remove");
    let open = ticket::Entity::find_by_id(tid.as_str()).one(&session).await.expect("db").expect("ticket");
    assert_eq!(open.assignee, None);
    // a ticket that is done keeps its assignee: the removed team stays as history
    let closed = ticket::Entity::find_by_id(done.as_str()).one(&session).await.expect("db").expect("ticket");
    assert_eq!(closed.assignee.as_deref(), Some(id));
    let (m, profile) = teams::get_profile(&session, id).await.expect("rows");
    assert_eq!(m.expect("member").kind, "ai_removed");
    assert!(profile.expect("profile").paused);
    // a removed team cannot be removed or edited again, and its name is free
    assert_eq!(refusal(teams::remove(&session, id, "An Nguyen", "unassign", None).await), "AI team not found.");
    assert_eq!(refusal(teams::update(&session, id, &body(json!({"effort": "low"})), "An").await), "AI team not found.");
    assert_eq!(teams::check_name(&session, &pid, "dev an", None).await.expect("check")["ok"], true);
}

#[tokio::test]
async fn pausing_and_removing_ask_the_runs_through_the_seam() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Dev An", json!({})).await;
    let id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let running = common::run(&pid, id, Some(&tid), "running", |_| {}).await;
    let starting = common::run(&pid, id, Some(&tid), "starting", |_| {}).await;
    let queued = common::run(&pid, id, Some(&tid), "queued", |_| {}).await;
    let waiting = common::run(&pid, id, Some(&tid), "needs_input", |_| {}).await;
    let session = database::session();

    // no `runs` yet: nothing to cancel, nothing to wake, and the team is paused all the same
    seams::set_runs(None);
    let profile = teams::set_paused(&session, id, true, "An Nguyen", true, None).await.expect("pause");
    assert!(profile.paused && profile.paused_at.is_some());
    assert_eq!(profile.paused_reason.as_deref(), Some("Paused by An Nguyen"));

    let calls = Arc::new(common::Cancels::default());
    seams::set_runs(Some(calls.clone()));
    // a pause leaves the runs alone and wakes the scheduler
    teams::set_paused(&session, id, true, "An Nguyen", false, Some("")).await.expect("pause");
    assert!(calls.cancelled.lock().expect("lock").is_empty());
    assert_eq!(calls.woken.load(Ordering::SeqCst), 1);
    // "cancel the current run": the runs that are starting or running, not the queued or waiting ones
    *calls.refuse.lock().expect("lock") = Some(CancelError::Run("The run already ended.".into()));
    teams::set_paused(&session, id, true, "An Nguyen", true, Some("stop")).await.expect("a RunError is passed over");
    let mut cancelled = calls.cancelled.lock().expect("lock").clone();
    cancelled.sort();
    let mut expected = vec![
        (running.id.clone(), "An Nguyen".to_string(), "Dev An was paused by An Nguyen".to_string()),
        (starting.id.clone(), "An Nguyen".to_string(), "Dev An was paused by An Nguyen".to_string()),
    ];
    expected.sort();
    assert_eq!(cancelled, expected);
    assert_eq!(calls.woken.load(Ordering::SeqCst), 1);
    // any other failure of `runs.cancel` reaches the caller
    *calls.refuse.lock().expect("lock") = Some(CancelError::Other("database is locked".into()));
    let failed = teams::set_paused(&session, id, true, "An Nguyen", true, None).await;
    assert!(matches!(failed, Err(Error::Other(ref m)) if m == "database is locked"), "{failed:?}");
    *calls.refuse.lock().expect("lock") = None;
    // a resume wakes the scheduler
    let profile = teams::set_paused(&session, id, false, "An Nguyen", true, Some("ignored")).await.expect("resume");
    assert!(!profile.paused && profile.paused_at.is_none() && profile.paused_reason.is_none());
    assert_eq!(calls.woken.load(Ordering::SeqCst), 2);
    assert_eq!(refusal(teams::set_paused(&session, "no-such", true, "An", false, None).await), "AI team not found.");

    // removing the team cancels every run in flight, queued and waiting ones too
    calls.cancelled.lock().expect("lock").clear();
    teams::remove(&session, id, "An Nguyen", "unassign", None).await.expect("remove");
    let mut cancelled: Vec<String> = calls.cancelled.lock().expect("lock").iter().map(|c| c.0.clone()).collect();
    cancelled.sort();
    let mut all = vec![running.id, starting.id, queued.id, waiting.id];
    all.sort();
    assert_eq!(cancelled, all);
    assert!(calls.cancelled.lock().expect("lock").iter().all(|c| c.2 == "Dev An was removed by An Nguyen"));
    seams::set_runs(None);
}

#[tokio::test]
async fn detect_local_says_what_is_installed_and_who_is_signed_in() {
    let _guard = common::init().await;
    let info = teams::detect_local(None, None, None).await.expect("detect");
    assert_eq!(info["found"], true);
    assert_eq!(info["path"], json!(common::fake_cli()));
    assert_eq!(info["logged_in"], true);
    assert_eq!(info["install"], "npm install -g @anthropic-ai/claude-code");
    assert_eq!(info["guide_url"], "https://docs.claude.com/en/docs/claude-code/setup");
    let keys: Vec<&String> = info.keys().collect();
    assert_eq!(keys, ["found", "path", "checked", "version", "logged_in", "account", "install", "guide_url"]);
    // a configured path that is not there: no other CLI is taken
    let missing = teams::detect_local(None, Some(&common::tmp_path("x").join("claude").to_string_lossy()), None)
        .await
        .expect("detect");
    assert!(missing["found"] == false && missing["path"].is_null() && missing["install"].is_string());
    // as an account: the board's own record of the sign-in, and who it is
    let account = common::account("Work").await;
    let session = database::session();
    let mut row = account.clone();
    row.email = Some("an@work.example".into());
    row.plan = Some("max".into());
    let account = kb_db::save_model(&session, &account, row).await.expect("save");
    session.commit().await.expect("commit");
    let info = teams::detect_local(Some(&session), None, Some(&account.id)).await.expect("detect");
    assert!(info["found"] == true && info["logged_in"] == true);
    assert_eq!(info["account"], "an@work.example · max");
    // signed out, and the CLI no longer says who it was
    let mut row = account.clone();
    row.status = "needs_sign_in".into();
    row.email = None;
    row.plan = None;
    kb_db::save_model(&session, &account, row).await.expect("save");
    session.commit().await.expect("commit");
    let info = teams::detect_local(Some(&session), None, Some(&account.id)).await.expect("detect");
    assert_eq!(info["logged_in"], false);
    assert_eq!(info["account"], "Work");
    // without a session the account is not looked up
    let info = teams::detect_local(None, None, Some(&account.id)).await.expect("detect");
    assert_eq!(info["logged_in"], true);
}

#[tokio::test]
async fn health_check_follows_a_runner_that_went_away_and_came_back() {
    let _guard = common::init().await;
    common::clear::<ai_team::Entity>().await;
    common::clear::<member::Entity>().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Dev An", json!({})).await;
    let id = team["id"].as_str().expect("id");
    let calls = Arc::new(common::Cancels::default());
    seams::set_runs(Some(calls.clone()));
    // healthy and checked a moment ago: nothing is asked
    assert_eq!(teams::health_check().await.expect("check"), 0);
    assert_eq!(calls.woken.load(Ordering::SeqCst), 0);
    // the CLI is gone (the path now names a file that is not there): the next stale check finds out
    let session = database::session();
    let gone = common::tmp_path("gone").join("claude");
    teams::update(&session, id, &body(json!({"cli_path": gone.to_string_lossy()})), "An").await.expect("update");
    assert_eq!(teams::health_check().await.expect("check"), 1);
    let now = common::described(id).await;
    assert!(now["health"] == "runner_missing" && now["status"]["code"] == "runner_missing", "{now:?}");
    assert!(now["checked_at"].is_string());
    assert_eq!(calls.woken.load(Ordering::SeqCst), 1);
    // still missing: checked again (it is not healthy), nothing changed
    assert_eq!(teams::health_check().await.expect("check"), 0);
    assert_eq!(calls.woken.load(Ordering::SeqCst), 1);
    // it is back
    let (_, profile) = teams::get_profile(&session, id).await.expect("rows");
    let read = profile.expect("profile");
    let mut profile = read.clone();
    profile.cli_path = Some(common::real_cli());
    kb_db::save_model(&session, &read, profile).await.expect("save");
    session.commit().await.expect("commit");
    assert_eq!(teams::health_check().await.expect("check"), 1);
    assert_eq!(common::described(id).await["health"], "ok");
    // a usage limit is kept by a check (only the next run that ends well clears it), a removed team is left alone
    let (_, profile) = teams::get_profile(&session, id).await.expect("rows");
    let read = profile.expect("profile");
    let mut profile = read.clone();
    assert!(teams::note_run_outcome(&mut profile, "failed", Some("rate_limited"), Some("resets 3pm")));
    kb_db::save_model(&session, &read, profile).await.expect("save");
    session.commit().await.expect("commit");
    assert_eq!(teams::health_check().await.expect("check"), 0);
    let now = common::described(id).await;
    assert!(
        now["health"] == "rate_limited"
            && now["health_detail"] == "resets 3pm"
            && now["status"]["label"] == "Rate-limited"
    );
    let r = teams::test_connection(&session, id).await.expect("test");
    assert!(r["ok"] == true && r["health"] == "rate_limited", "{r:?}");
    // the audit log has both changes, by the board
    let entries = kb_ai::audit::list_entries(&session, &pid, &Default::default(), 50, None).await.expect("audit");
    let changes: Vec<Value> = entries
        .iter()
        .filter(|e| e.action == "team_health")
        .map(|e| {
            assert!(e.on_behalf_of.as_deref() == Some("board") && e.member_name == "Dev An");
            serde_json::from_str(&e.detail).expect("detail")
        })
        .collect();
    assert_eq!(changes.len(), 2, "{changes:?}");
    assert!(changes.contains(&json!({"from": "unknown", "to": "runner_missing"})));
    assert!(changes.contains(&json!({"from": "runner_missing", "to": "ok"})));
    seams::set_runs(None);
}

/// `server/crates/kb-board/tests/test_members.rs` returns early on the Rust server while no crate backs
/// `AiTeamsHook::check_name`. Here the hook is registered (`kb_ai_run::register`) and the 409 branches of `POST
/// /projects/{id}/members` are checked through the board's own router, in this process.
#[tokio::test]
async fn post_member_refuses_a_name_that_is_taken() {
    let _guard = common::init().await;
    kb_ai_run::register();
    let project = |name: &'static str| async move {
        let session = database::session();
        let mut row = kb_db::entities::project::new();
        row.name = Set(name.into());
        row.prefix = Set(format!("M{}", kb_base::time::uuid4_hex()[..4].to_uppercase()));
        row.color = Set("#2E6F40".into());
        row.ticket_counter = Set(0);
        let row = kb_db::sea_orm::ActiveModelTrait::insert(row, &session).await.expect("project");
        session.commit().await.expect("commit");
        row.id
    };
    let pid = project("Team").await;
    let path = format!("/projects/{pid}/members");
    let (status, an) = post(&path, json!({"name": "An Nguyen"})).await;
    assert_eq!(status, StatusCode::CREATED, "{an}");
    // case and the spaces around are ignored
    let (status, r) = post(&path, json!({"name": "  an nguyen "})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(r, json!({"detail": "“An Nguyen” is already a member of Team."}));
    // an AI member's name
    let session = database::session();
    let mut ai = member::new();
    ai.id = Set(format!("ai-{}", &kb_base::time::uuid4_hex()[..6]));
    ai.project_id = Set(pid.clone());
    ai.name = Set("Claude Code".into());
    ai.color = Set("#000000".into());
    ai.kind = Set("ai".into());
    let ai = kb_db::sea_orm::ActiveModelTrait::insert(ai, &session).await.expect("member");
    session.commit().await.expect("commit");
    let (status, r) = post(&path, json!({"name": "claude  code"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(r, json!({"detail": "An AI member already uses the name “claude code”."}));
    // a removed AI member's name is free, and so is the same name in another project
    let mut gone = ai.clone();
    gone.kind = "ai_removed".into();
    kb_db::save_model(&session, &ai, gone).await.expect("save");
    session.commit().await.expect("commit");
    drop(session);
    let (status, _) = post(&path, json!({"name": "Claude Code"})).await;
    assert_eq!(status, StatusCode::CREATED);
    let other = project("Other").await;
    let (status, _) = post(&format!("/projects/{other}/members"), json!({"name": "An Nguyen"})).await;
    assert_eq!(status, StatusCode::CREATED);
}
