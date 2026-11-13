//! `server/tests/test_ai_teams.py` through the routes of `api/ai.py`: making, editing, pausing and removing a team; the
//! team check; the project's AI settings. `crates/kb-ai-run/tests/test_ai_teams.rs` ports the same file at service
//! level; the two tests that call `services.ai.roles` directly (`test_roles_become_agents_json_and_markdown`,
//! `test_every_team_pack_resolves_to_known_roles`) are in `crates/kb-ai-know/tests/test_ai_teams.rs` and are not
//! repeated here.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use common::{id, project, runner, sign_in, start, ticket, tmp};
use serde_json::{Value, json};

#[tokio::test]
async fn test_a_team_is_made_with_its_pack_and_checked() {
    let Some(f) = start("test_a_team_is_made_with_its_pack_and_checked", true, &[]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Dev An", json!({})).await;
    assert_eq!(team["name"], "Dev An");
    assert_eq!(team["kind"], "ai");
    assert_eq!(team["pack_key"], "standard");
    let keys: Vec<&Value> = team["roles"].as_array().expect("roles").iter().map(|r| &r["key"]).collect();
    assert_eq!(keys, ["dev", "reviewer", "qa"]);
    assert_eq!(team["permission_mode"], "bypass");
    assert!(["idle", "runner_missing", "not_logged_in"].contains(&team["status"]["code"].as_str().unwrap_or("")));
    // the fake CLI answers `auth status` as signed in: the runner is found
    assert_eq!(team["health"], "ok", "{}", team["health_detail"]);
    let listed = c.get(&format!("/projects/{pid}/ai/teams")).await.json();
    let ids: Vec<&Value> = listed.as_array().expect("list").iter().map(|t| &t["id"]).collect();
    assert_eq!(ids, [&team["id"]]);
    // the team is a member of the project too: it can be the assignee and the comment author
    let members = c.get(&format!("/projects/{pid}/members")).await.json();
    assert!(members.as_array().expect("members").iter().any(|m| m["id"] == team["id"] && m["kind"] == "ai"));
}

#[tokio::test]
async fn test_names_are_unique_across_people_and_teams() {
    let Some(f) = start("test_names_are_unique_across_people_and_teams", true, &[]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    runner(&f, &pid, "Dev An", json!({})).await;
    let body = |name: &str| {
        json!({"name": name, "working_dir": common::repo(&f).to_string_lossy(),
               "cli_path": f.bin.join("claude").to_string_lossy()})
    };
    let r = c.post(&format!("/projects/{pid}/ai/teams"), body("dev an")).await;
    assert_eq!(r.status, 422);
    let detail = r.json()["detail"].as_str().unwrap_or_default().to_string();
    assert!(detail.contains("Dev An 2") || detail.contains("already"), "{detail}");
    let r = c.post(&format!("/projects/{pid}/ai/teams"), body("An Nguyen")).await;
    assert_eq!(r.status, 422);
    let r = c.post(&format!("/projects/{pid}/members"), json!({"name": "Dev An"})).await;
    assert!(r.status == 409 || r.status == 422, "{}", r.status);
}

#[tokio::test]
async fn test_edit_pack_roles_and_settings() {
    let Some(f) = start("test_edit_pack_roles_and_settings", true, &[]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = id(&team);
    let r = c
        .patch(
            &format!("/ai/teams/{tid}"),
            json!({"pack_key": "feature_ui", "effort": "high", "permission_mode": "auto",
                   "config": {"roles": [{"key": "qa", "off": true}, {"key": "security", "model": "stand-in"}]}}),
        )
        .await;
    r.assert_status(200);
    let out = r.json();
    let keys: Vec<&str> = out["roles"].as_array().expect("roles").iter().filter_map(|x| x["key"].as_str()).collect();
    assert!(!keys.contains(&"qa") && keys.last() == Some(&"security"), "{keys:?}");
    let security = out["roles"].as_array().expect("roles").iter().find(|x| x["key"] == "security").expect("security");
    assert_eq!(security["model"], "stand-in");
    assert!(out["effort"] == "high" && out["permission_mode"] == "auto");
    assert_eq!(c.patch(&format!("/ai/teams/{tid}"), json!({"effort": "extreme"})).await.status, 422);
    assert_eq!(c.patch(&format!("/ai/teams/{tid}"), json!({"permission_mode": "ask"})).await.status, 422);
}

#[tokio::test]
async fn test_pause_resume_and_remove_unassign_the_tickets() {
    let Some(f) = start("test_pause_resume_and_remove_unassign_the_tickets", true, &[]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, an) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await;
    let r = c.post(&format!("/ai/teams/{}/pause", id(&team)), json!({"reason": "lunch"})).await.json();
    assert!(r["paused"] == true && r["status"]["code"] == "paused", "{r}");
    let r = c.post_empty(&format!("/ai/teams/{}/resume", id(&team))).await.json();
    assert_eq!(r["paused"], false);
    let impact = c.get(&format!("/ai/teams/{}/removal-impact", id(&team))).await.json();
    let open: Vec<&Value> = impact["open_tickets"].as_array().expect("open").iter().map(|t| &t["id"]).collect();
    assert_eq!(open, [&json!(tid)]);
    let r = c.post(&format!("/ai/teams/{}/remove", id(&team)), json!({"tickets": "reassign", "reassign_to": an})).await;
    r.assert_status(200);
    let ticket_now = c.get(&format!("/tickets/{tid}")).await.json();
    assert_eq!(ticket_now["assignee"], json!(an));
    assert_eq!(c.get(&format!("/projects/{pid}/ai/teams")).await.json(), json!([]));
    let removed = c.get(&format!("/projects/{pid}/ai/teams?include_removed=true")).await.json();
    assert_eq!(removed[0]["kind"], "ai_removed");
}

#[tokio::test]
async fn test_settings_pause_all_and_overview() {
    let Some(f) = start("test_settings_pause_all_and_overview", true, &[]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let s = c.get(&format!("/projects/{pid}/ai/settings")).await.json();
    assert!(s["permission_mode"] == "bypass" && s["deny_list"] == json!([]), "{s}");
    let r = c
        .patch(
            &format!("/projects/{pid}/ai/settings"),
            json!({"deny_list": ["Bash(git push --force*)", " "], "lessons_mode": "review",
                   "ops": {"live_messages": false}}),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.json()["deny_list"], json!(["Bash(git push --force*)"]));
    assert_eq!(r.json()["lessons_mode"], "review");
    assert_eq!(r.json()["ops"]["live_messages"], false);
    assert_eq!(c.patch(&format!("/projects/{pid}/ai/settings"), json!({"permission_mode": "yolo"})).await.status, 422);
    let r = c.post(&format!("/projects/{pid}/ai/pause-all"), json!({"reason": "stop"})).await;
    assert_eq!(r.json()["paused_all"], true);
    let over = c.get(&format!("/projects/{pid}/ai/overview")).await.json();
    assert_eq!(over["paused_all"], true);
    assert_eq!(over["teams"][0]["id"], team["id"]);
    assert_eq!(over["teams"][0]["status"]["code"], "paused_all");
    let r = c.post_empty(&format!("/projects/{pid}/ai/resume-all")).await;
    assert_eq!(r.json()["paused_all"], false);
    let board = c.get(&format!("/projects/{pid}/ai/board")).await.json();
    assert_eq!(board, json!({"tickets": {}}));
}

/// The UI reads `ok` and `message` of `POST /ai/teams/{id}/test` (it said "check failed" for a healthy team).
#[tokio::test]
async fn test_the_check_says_ok_and_why() {
    let Some(f) = start("test_the_check_says_ok_and_why", true, &[]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = id(&team);
    let r = c.post_empty(&format!("/ai/teams/{tid}/test")).await.json();
    assert!(
        r["ok"] == true && r["health"] == "ok" && r["message"].as_str().unwrap_or_default().contains("Claude Code"),
        "{r}"
    );
    let gone = tmp(&f).join("no-such").join("claude");
    c.patch(&format!("/ai/teams/{tid}"), json!({"cli_path": gone.to_string_lossy()})).await;
    let r = c.post_empty(&format!("/ai/teams/{tid}/test")).await.json();
    assert!(r["ok"] == false && r["health"] == "runner_missing" && r["message"] == r["health_detail"], "{r}");
}
