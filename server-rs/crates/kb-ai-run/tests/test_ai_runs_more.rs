//! Tests of other Python files that need a real run and were left for `runs`: each is named after its Python test,
//! and says which file it comes from. As in `test_ai_runs_v2.rs`, a request of the Python test is the service call its
//! route makes.
//!
//! Still waiting (they need the routes of `api/ai.py`, or modules of part 3): see the report of the task.

mod common;

use common::runs_env::{Env, assign, last_run, wait};
use kb_ai::{quota, transcripts};
use kb_ai_run::runs;
use kb_db::database;
use kb_db::entities::{ai_account_state, ai_audit, ai_run_transcript};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::json;

fn git(cwd: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=T"])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// `POST /tickets/{id}/ai/run` with an empty body: `runs.start_on_ticket`.
async fn run_button(ticket_id: &str) {
    let session = database::session();
    runs::start_on_ticket(&session, ticket_id, None, "user", "", "work").await.expect("the run is queued");
}

// `tests/test_ai_quota_budget_v2.py`
#[tokio::test]
async fn test_a_weekly_limit_in_a_run_holds_the_account_and_the_next_run_waits() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "window")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let first = common::ticket(&pid, "First", "todo").await.id;
    run_button(&first).await;
    wait(&first, &["failed", "finished"], 30.0).await;
    let row = {
        let session = database::session();
        ai_account_state::Entity::find_by_id("local").one(&session).await.expect("query").expect("the account's row")
    };
    assert!(quota::held(Some(&row), None).is_some());
    assert!(row.seven_day_used == Some(1.0) && row.seven_day_status.as_deref() == Some("rejected"));
    // the next run of the same account is not started: it waits, and says for which window
    let second = common::ticket(&pid, "Second", "todo").await.id;
    run_button(&second).await;
    wait(&second, &["queued"], 10.0).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let run = last_run(&second).await.expect("the run");
    assert_eq!(run["state"], "queued");
    assert!(run["waiting_reason"].as_str().unwrap_or("").starts_with("Waiting for the next window"), "{run}");
    assert!(team["id"].is_string());
    env.stop().await;
}

// `tests/test_ai_audit_ops_v2.py`
#[tokio::test]
async fn test_creating_a_team_and_running_it_leave_audit_entries() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    // (Python starts on a new database: the entries of the project are the first ones)
    common::clear::<ai_audit::Entity>().await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    run_button(&tid).await;
    wait(&tid, &["finished", "failed"], 30.0).await;
    let rows = {
        let session = database::session();
        ai_audit::Entity::find()
            .filter(ai_audit::Column::ProjectId.eq(pid.as_str()))
            .order_by_asc(ai_audit::Column::Seq)
            .all(&session)
            .await
            .expect("entries")
    };
    let actions: Vec<&str> = rows.iter().map(|r| r.action.as_str()).collect();
    assert_eq!(actions[0], "team_created");
    assert!(json!(rows[0].member_id) == team["id"] && json!(rows[0].member_name) == team["name"]);
    assert!(actions.contains(&"run_queued"));
    let ended: Vec<_> = rows.iter().filter(|r| matches!(r.action.as_str(), "run_finished" | "run_failed")).collect();
    let last = ended.last().expect("an entry of the run's end");
    assert!(last.run_id.is_some() && last.target.as_deref() == Some(tid.as_str()));
    assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), (1..=rows.len() as i32).collect::<Vec<_>>());
    env.stop().await;
}

// `tests/test_ai_transcripts_v2.py`
#[tokio::test]
async fn test_a_full_v2_run_leaves_a_masked_compressed_transcript() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["finished"], 30.0).await;
    let run_id = run["id"].as_str().expect("id");
    let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut row = None;
    while std::time::Instant::now() < end {
        let session = database::session();
        row = ai_run_transcript::Entity::find_by_id(run_id).one(&session).await.expect("query");
        if row.as_ref().is_some_and(|r| r.ended_at.is_some()) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let row = row.expect("the transcript's row");
    assert!(row.ended_at.is_some() && row.path.ends_with(".jsonl.gz"), "{}", row.path);
    let recs = transcripts::read(run_id).await.expect("read").expect("the records");
    assert!(recs[0]["k"] == "sent" && recs[0]["prompt"] != "" && recs[0]["system"] != "");
    assert!(recs.iter().any(|r| r["k"] == "event" && r["e"]["type"] == "result"));
    assert!(recs.len() as i64 == i64::from(row.events) && row.events >= 5);
    let gz = std::process::Command::new("gzip").args(["-dc", &row.path]).output().expect("gzip runs");
    let raw = String::from_utf8_lossy(&gz.stdout).into_owned();
    assert!(!raw.is_empty() && !raw.replace("kbr_••••", "").contains("kbr_"));
    env.stop().await;
}

// `tests/test_ai_worktrees_v2.py`
#[tokio::test]
async fn test_the_cli_gets_the_worktrees_port_in_its_environment() {
    let _guard = common::init().await;
    let record = common::tmp_path("cwd").join("cwd.jsonl");
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_CWD_RECORD", &record.to_string_lossy())]).await;
    let (pid, _) = common::project().await;
    common::set_ops(&pid, json!({"worktrees": {"on": true, "handover": "local", "base_port": 5190}})).await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let repo = std::path::PathBuf::from(team["working_dir"].as_str().expect("working folder"));
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["finished", "failed"], 30.0).await;
    assert_eq!(run["state"], "finished", "{run}");
    let text = std::fs::read_to_string(&record).expect("what the CLI recorded");
    let last: serde_json::Value = serde_json::from_str(text.lines().last().expect("a line")).expect("json");
    assert_eq!(last["port"], "5190");
    // the CLI worked in the ticket's worktree, not in the team's shared folder
    let worktree = {
        let session = database::session();
        kb_ai_work::worktrees::for_ticket(&session, &tid).await.expect("query").expect("the worktree")
    };
    assert_eq!(last["cwd"], json!(worktree.path));
    assert!(last["cwd"] != team["working_dir"]);
    env.stop().await;
}

// `tests/test_ai_cli_path.py`
#[tokio::test]
async fn test_a_run_of_an_ai_with_an_unusable_cli_path_waits_and_says_why() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    // (a `claude` that works is on PATH, as in the Python test: the board must not run it instead)
    let unusable = common::script(&common::tmp_path("unusable"), "claude", "exit 0", false);
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({"cli_path": unusable.to_string_lossy()})).await;
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix it", "todo").await.id;
    assign(&tid, team_id).await;
    // the team is marked without a runner, with the reason, and its run waits: nothing else is started
    let got = common::described(team_id).await;
    assert_eq!(got["health"], "runner_missing");
    let detail = got["health_detail"].as_str().expect("why");
    assert!(detail.contains(&*unusable.to_string_lossy()), "{detail}");
    assert!(detail.contains("not executable") && detail.contains("does not run another claude"), "{detail}");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let run = last_run(&tid).await.expect("the run");
    assert!(run["state"] == "queued" && run["started_at"].is_null(), "{run}");
    env.stop().await;
}

// `tests/test_ai_worktrees_v2.py` (the run's end; the worktree itself is checked in `kb-ai-work`)
#[tokio::test]
async fn test_a_repository_with_no_commit_stops_the_run_and_says_what_to_do() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    let (pid, _) = common::project().await;
    common::set_ops(&pid, json!({"worktrees": {"on": true, "handover": "local"}})).await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    // no commit: the branch has nothing to start from
    git(std::path::Path::new(team["working_dir"].as_str().expect("working folder")), &["init", "-q", "-b", "main"]);
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["finished", "failed"], 30.0).await;
    assert_eq!(run["state"], "failed");
    let reason = run["ended_reason"].as_str().expect("why");
    assert!(reason.contains("no commit yet") && reason.contains("git commit --allow-empty"), "{reason}");
    assert_eq!(run["stop_code"], "board_fault");
    env.stop().await;
}

// `tests/test_ai_worktrees_v2.py`: with worktrees off the CLI works in the team's own folder
#[tokio::test]
async fn test_with_worktrees_off_the_run_works_in_the_shared_folder() {
    let _guard = common::init().await;
    let record = common::tmp_path("cwd").join("cwd.jsonl");
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_CWD_RECORD", &record.to_string_lossy())]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let repo = std::path::PathBuf::from(team["working_dir"].as_str().expect("working folder"));
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["finished", "failed"], 30.0).await;
    assert_eq!(run["state"], "finished");
    let text = std::fs::read_to_string(&record).expect("what the CLI recorded");
    let last: serde_json::Value = serde_json::from_str(text.lines().last().expect("a line")).expect("json");
    let cwd = std::path::PathBuf::from(last["cwd"].as_str().expect("cwd"));
    assert_eq!(cwd.canonicalize().expect("cwd"), repo.canonicalize().expect("repo"));
    let session = database::session();
    assert!(kb_ai_work::worktrees::for_ticket(&session, &tid).await.expect("query").is_none());
    drop(session);
    env.stop().await;
}

// `tests/test_ai_teams.py` covers pausing through whole runs: "pause and cancel the current run" against a real one
#[tokio::test]
async fn pausing_a_team_with_its_current_run_cancels_the_run_and_stops_its_cli() {
    let _guard = common::init().await;
    let env =
        Env::start(&[("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"), ("FAKE_CLAUDE_WAIT", "30")])
            .await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team_id).await;
    let run = wait(&tid, &["running"], 20.0).await;
    let cli = i32::try_from(run["pid"].as_i64().expect("pid")).expect("pid");
    {
        let session = database::session();
        kb_ai_run::teams::set_paused(&session, team_id, true, "An Nguyen", true, Some("lunch")).await.expect("pause");
    }
    let ended = wait(&tid, &["cancelled"], 10.0).await;
    assert_eq!(ended["ended_by"], "An Nguyen");
    common::until("the CLI to stop", 10.0, || !common::alive(cli)).await;
    // a paused team starts nothing: a new run waits and says why
    let second = common::ticket(&pid, "Fix sub()", "todo").await.id;
    assign(&second, team_id).await;
    let mut waiting = wait(&second, &["queued"], 10.0).await;
    for _ in 0..60 {
        if !waiting["waiting_reason"].is_null() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        waiting = wait(&second, &["queued"], 10.0).await;
    }
    assert_eq!(waiting["waiting_reason"], "Claude Code · Backend is paused");
    env.stop().await;
}
