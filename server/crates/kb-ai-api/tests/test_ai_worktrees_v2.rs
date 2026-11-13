//! `server/tests/test_ai_worktrees_v2.py` through the routes of `api/ai_code.py` and a full run of the stand-in CLI:
//! one worktree per ticket beside the repo with a port of its own, nothing written into the repo, merging only when a
//! person asks, a conflict rolled back, uncommitted work never removed. `crates/kb-ai-work/tests/test_ai_worktrees_v2.rs`
//! ports the file at service level.
//!
//! Not repeated here (service level, in `kb-ai-work`): `test_auto_route_is_local_without_a_remote_and_branch_for_another_host`,
//! `test_only_a_github_host_is_github`, `test_review_with_a_local_route_does_nothing_and_a_failed_push_is_reported`,
//! `test_a_move_to_review_while_a_run_works_waits_for_the_run_to_stop`,
//! `test_a_person_moving_to_review_hands_over_at_once_and_an_ai_move_to_done_merges_nothing`,
//! `test_the_run_ending_delivers_a_review_handover_that_waited_for_it` (they replace `worktrees.on_review` / `merge`
//! with recorders), `test_names_and_paths` and `test_outputs_are_told_from_code`.
//!
//! The Python tests change `FAKE_CLAUDE_*` with `monkeypatch.setenv` before the run they start; a server here starts
//! with the variables of its test. `FAKE_CLAUDE_CWD_RECORD` and the like name files in a folder of the test.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use common::{Fixture, id, project, runner_in, scalar, sign_in, start, ticket, tmp, wait_run};
use serde_json::{Value, json};

/// `_git(cwd, *args)`: git with the identity the Python tests give it; its output.
fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=T"])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The `repo` fixture: the test's repository, initialised with its one commit.
fn repo_of(f: &Fixture) -> PathBuf {
    let path = common::repo(f);
    git(&path, &["init", "-q", "-b", "main"]);
    git(&path, &["add", "-A"]);
    git(&path, &["commit", "-q", "-m", "first"]);
    path
}

/// A server for one of these tests: `FAKE_CLAUDE_MODE=v2`, its own folder of runs, and the variables of the test.
async fn board(name: &str, extra: &[(&str, &str)]) -> Option<(Fixture, tempfile::TempDir)> {
    let dir = tempfile::Builder::new().prefix("kb-ai-api-wt-").tempdir().expect("temporary folder");
    let runs = dir.path().join("ai-runs");
    let mut env: Vec<(&str, &str)> =
        vec![("FAKE_CLAUDE_MODE", "v2"), ("KANBAN_AI_RUNS_DIR", runs.to_str().expect("a path"))];
    env.extend_from_slice(extra);
    let f = start(name, true, &env).await?;
    sign_in(&f);
    Some((f, dir))
}

/// `_on(c, pid, **extra)`: worktrees on, handing over locally.
async fn on(f: &Fixture, pid: &str, extra: Value) {
    let mut cfg = json!({"on": true, "handover": "local"});
    for (key, value) in extra.as_object().expect("extra") {
        cfg[key] = value.clone();
    }
    let r = f.c.patch(&format!("/projects/{pid}/ai/settings"), json!({"ops": {"worktrees": cfg}})).await;
    r.assert_status(200);
}

/// `_run_ticket(c, pid, team, title)`: a ticket given to the team, and its run once it has ended.
async fn run_ticket(f: &Fixture, pid: &str, team: &Value, title: &str) -> (String, Value) {
    let tid = ticket(&f.c, pid, title, "todo").await;
    f.c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await.assert_status(200);
    let run = wait_run(&f.c, &tid, &["finished", "failed"]).await;
    (tid, run)
}

/// `_setup_ticket(env, repo, **wt)`: a project with worktrees on, a team and a finished run.
async fn setup_ticket(f: &Fixture, repo: &Path, wt: Value) -> (String, Value, String) {
    let (pid, _) = project(&f.c).await;
    on(f, &pid, wt).await;
    let team = runner_in(f, &pid, repo, "Claude Code · Backend", json!({})).await;
    let (tid, run) = run_ticket(f, &pid, &team, "Fix add()").await;
    assert_eq!(run["state"], "finished", "{run}");
    (pid, team, tid)
}

/// `_until(pred)`: poll a condition for ten seconds.
async fn until(what: &str, mut check: impl AsyncFnMut() -> bool) {
    let end = tokio::time::Instant::now() + Duration::from_secs(10);
    while !check().await {
        assert!(tokio::time::Instant::now() < end, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The last line of a record the stand-in CLI wrote.
fn last_record(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).expect("the record");
    serde_json::from_str(text.lines().last().expect("a line")).expect("JSON")
}

fn same(a: &str, b: &Path) -> bool {
    Path::new(a).canonicalize().ok() == b.canonicalize().ok()
}

#[tokio::test]
async fn test_a_ticket_works_in_its_own_worktree_beside_the_repo_with_a_port() {
    let name = "test_a_ticket_works_in_its_own_worktree_beside_the_repo_with_a_port";
    let dir = tempfile::Builder::new().prefix("kb-ai-api-cwd-").tempdir().expect("temporary folder");
    let where_ = dir.path().join("cwd.jsonl");
    let Some((f, _keep)) = board(name, &[("FAKE_CLAUDE_CWD_RECORD", where_.to_str().expect("a path"))]).await else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _) = project(&f.c).await;
    on(&f, &pid, json!({"base_port": 5190})).await;
    let team = runner_in(&f, &pid, &repo, "Claude Code · Backend", json!({})).await;
    let (tid, run) = run_ticket(&f, &pid, &team, "Fix add()").await;
    assert_eq!(run["state"], "finished");
    let seen = last_record(&where_);
    let expected = repo
        .parent()
        .expect("parent")
        .join(format!("{}.worktrees", repo.file_name().expect("name").to_string_lossy()))
        .join(&tid);
    assert!(same(seen["cwd"].as_str().expect("cwd"), &expected), "{seen}");
    let wt = f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json();
    assert!(
        wt["branch"].as_str().unwrap_or_default().starts_with(&format!("ai/{tid}-fix-add")) && wt["base"] == "main"
    );
    assert!(wt["state"] == "active" && wt["live"]["exists"] == true);
    // nothing the board wrote landed in the repository
    assert!(!repo.join(".claude").exists());
    let listing = f.c.get(&format!("/projects/{pid}/ai/worktrees")).await.json();
    let ids: Vec<&Value> =
        listing["worktrees"].as_array().expect("worktrees").iter().map(|w| &w["ticket_id"]).collect();
    assert_eq!(ids, [&json!(tid)]);
}

#[tokio::test]
async fn test_the_cli_gets_the_worktrees_port_in_its_environment() {
    let dir = tempfile::Builder::new().prefix("kb-ai-api-cwd-").tempdir().expect("temporary folder");
    let where_ = dir.path().join("cwd.jsonl");
    let Some((f, _keep)) = board(
        "test_the_cli_gets_the_worktrees_port_in_its_environment",
        &[("FAKE_CLAUDE_CWD_RECORD", where_.to_str().expect("a path"))],
    )
    .await
    else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _) = project(&f.c).await;
    on(&f, &pid, json!({"base_port": 5190})).await;
    let team = runner_in(&f, &pid, &repo, "Claude Code · Backend", json!({})).await;
    run_ticket(&f, &pid, &team, "Fix add()").await;
    assert_eq!(last_record(&where_)["port"], "5190");
}

#[tokio::test]
async fn test_the_same_ticket_keeps_its_worktree_and_another_gets_the_next_port() {
    let Some((f, _keep)) = board("test_the_same_ticket_keeps_its_worktree_and_another_gets_the_next_port", &[]).await
    else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _) = project(&f.c).await;
    on(&f, &pid, json!({"base_port": 5300})).await;
    let team = runner_in(&f, &pid, &repo, "Claude Code · Backend", json!({})).await;
    let (t1, _) = run_ticket(&f, &pid, &team, "One").await;
    let (t2, _) = run_ticket(&f, &pid, &team, "Two").await;
    let ports = |listing: Value| -> Vec<(String, i64)> {
        let mut out: Vec<(String, i64)> = listing["worktrees"]
            .as_array()
            .expect("worktrees")
            .iter()
            .map(|w| (w["ticket_id"].as_str().unwrap_or_default().to_string(), w["port"].as_i64().unwrap_or(0)))
            .collect();
        out.sort();
        out
    };
    let first = f.c.get(&format!("/tickets/{t1}/ai/worktree")).await.json();
    let listing = f.c.get(&format!("/projects/{pid}/ai/worktrees")).await.json();
    assert_eq!(ports(listing), vec![(t1.clone(), 5300), (t2.clone(), 5301)]);
    // the same ticket again (the Python test calls `worktrees.ensure`): the run finds its worktree and its port
    f.c.post(&format!("/tickets/{t1}/ai/run"), json!({})).await.assert_status(200);
    wait_run(&f.c, &t1, &["finished", "failed"]).await;
    let again = f.c.get(&format!("/tickets/{t1}/ai/worktree")).await.json();
    assert!(again["path"] == first["path"] && again["port"] == 5300, "{again}");
}

#[tokio::test]
async fn test_a_folder_that_is_not_a_repository_falls_back_to_the_shared_folder() {
    let dir = tempfile::Builder::new().prefix("kb-ai-api-cwd-").tempdir().expect("temporary folder");
    let where_ = dir.path().join("cwd.jsonl");
    let name = "test_a_folder_that_is_not_a_repository_falls_back_to_the_shared_folder";
    let Some((f, _keep)) = board(name, &[("FAKE_CLAUDE_CWD_RECORD", where_.to_str().expect("a path"))]).await else {
        return;
    };
    let (pid, _) = project(&f.c).await;
    on(&f, &pid, json!({})).await;
    // never git-initialised
    let team = runner_in(&f, &pid, &common::repo(&f), "Claude Code · Backend", json!({})).await;
    let (tid, run) = run_ticket(&f, &pid, &team, "Fix add()").await;
    assert_eq!(run["state"], "finished");
    assert!(same(last_record(&where_)["cwd"].as_str().expect("cwd"), &common::repo(&f)));
    assert_eq!(f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json(), Value::Null);
}

#[tokio::test]
async fn test_with_worktrees_off_the_team_keeps_its_own_folder() {
    let dir = tempfile::Builder::new().prefix("kb-ai-api-cwd-").tempdir().expect("temporary folder");
    let where_ = dir.path().join("cwd.jsonl");
    let Some((f, _keep)) = board(
        "test_with_worktrees_off_the_team_keeps_its_own_folder",
        &[("FAKE_CLAUDE_CWD_RECORD", where_.to_str().expect("a path"))],
    )
    .await
    else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _) = project(&f.c).await;
    let team = runner_in(&f, &pid, &repo, "Claude Code · Backend", json!({})).await;
    let (tid, run) = run_ticket(&f, &pid, &team, "Fix add()").await;
    assert_eq!(run["state"], "finished");
    assert!(same(last_record(&where_)["cwd"].as_str().expect("cwd"), &repo));
    assert_eq!(f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json(), Value::Null);
}

#[tokio::test]
async fn test_a_repository_with_no_commit_stops_the_run_and_says_what_to_do() {
    let Some((f, _keep)) = board("test_a_repository_with_no_commit_stops_the_run_and_says_what_to_do", &[]).await
    else {
        return;
    };
    // no commit: the branch has nothing to start from
    git(&common::repo(&f), &["init", "-q", "-b", "main"]);
    let (pid, _) = project(&f.c).await;
    on(&f, &pid, json!({})).await;
    let team = runner_in(&f, &pid, &common::repo(&f), "Claude Code · Backend", json!({})).await;
    let (_tid, run) = run_ticket(&f, &pid, &team, "Fix add()").await;
    assert_eq!(run["state"], "failed");
    let row = f.c.get(&format!("/ai/runs/{}", id(&run))).await.json();
    let reason = row["ended_reason"].as_str().unwrap_or_default();
    assert!(reason.contains("no commit yet") && reason.contains("git commit --allow-empty"), "{reason}");
    assert_eq!(row["stop_code"], "board_fault");
}

#[tokio::test]
async fn test_a_failing_prepare_command_fails_the_run_with_its_output() {
    let Some((f, _keep)) = board("test_a_failing_prepare_command_fails_the_run_with_its_output", &[]).await else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _) = project(&f.c).await;
    on(&f, &pid, json!({"prepare": "echo 'npm exploded' >&2; exit 3"})).await;
    let team = runner_in(&f, &pid, &repo, "Claude Code · Backend", json!({})).await;
    let (_tid, run) = run_ticket(&f, &pid, &team, "Fix add()").await;
    assert_eq!(run["state"], "failed");
    let reason = run["ended_reason"].as_str().unwrap_or_default();
    assert!(reason.contains("prepare command") && reason.contains("npm exploded"), "{reason}");
}

#[tokio::test]
async fn test_a_worktree_made_again_runs_the_prepare_command_again() {
    let Some((f, _keep)) = board("test_a_worktree_made_again_runs_the_prepare_command_again", &[]).await else {
        return;
    };
    let repo = repo_of(&f);
    let count = tmp(&f).join("prepared.txt");
    let (pid, _) = project(&f.c).await;
    on(&f, &pid, json!({"prepare": format!("printf x >> '{}'", count.display())})).await;
    let team = runner_in(&f, &pid, &repo, "Claude Code · Backend", json!({})).await;
    let (tid, run) = run_ticket(&f, &pid, &team, "Fix add()").await;
    assert!(run["state"] == "finished" && std::fs::read_to_string(&count).expect("count") == "x");
    assert!(f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json()["prepared_at"].is_string());
    let r = f.c.post(&format!("/tickets/{tid}/ai/worktree/remove"), json!({})).await;
    r.assert_status(200);
    assert!(r.json()["state"] == "removed" && r.json()["port"].is_null());
    let gone = repo
        .parent()
        .expect("parent")
        .join(format!("{}.worktrees", repo.file_name().expect("name").to_string_lossy()))
        .join(&tid);
    assert!(!gone.exists());
    assert_eq!(f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json(), Value::Null);
    let r = f.c.post(&format!("/tickets/{tid}/ai/run"), json!({})).await;
    assert!(r.status == 200 || r.status == 201);
    tokio::time::sleep(Duration::from_millis(300)).await;
    wait_run(&f.c, &tid, &["finished", "failed"]).await;
    assert_eq!(std::fs::read_to_string(&count).expect("count"), "xx");
}

#[tokio::test]
async fn test_a_person_moving_the_ticket_to_done_merges_and_removes_the_worktree() {
    let commit = "def add(a, b):\n    return a + b\n";
    let name = "test_a_person_moving_the_ticket_to_done_merges_and_removes_the_worktree";
    let Some((f, _keep)) = board(name, &[("FAKE_CLAUDE_COMMIT", commit)]).await else { return };
    let repo = repo_of(&f);
    let (_pid, _team, tid) = setup_ticket(&f, &repo, json!({})).await;
    // not merged yet
    assert!(std::fs::read_to_string(repo.join("calc.py")).expect("calc.py").contains("a - b"));
    f.c.patch(&format!("/tickets/{tid}"), json!({"status": "done"})).await;
    until("the worktree is merged and removed", async || {
        let row = scalar(
            &f.server,
            "SELECT json_object('state', state, 'merged_at', merged_at) FROM ai_worktree WHERE ticket_id = ?",
            &[json!(tid)],
        )
        .await;
        row["state"] == "removed" && row["merged_at"].is_string()
    })
    .await;
    assert!(std::fs::read_to_string(repo.join("calc.py")).expect("calc.py").contains("a + b"));
    assert!(git(&repo, &["log", "--oneline", "-3"]).contains(&format!("Merge {tid}")));
}

#[tokio::test]
async fn test_a_conflict_is_rolled_back_and_the_worktree_is_left_as_the_ai_made_it() {
    let commit = "def add(a, b):\n    return a + b  # AI\n";
    let name = "test_a_conflict_is_rolled_back_and_the_worktree_is_left_as_the_ai_made_it";
    let Some((f, _keep)) = board(name, &[("FAKE_CLAUDE_COMMIT", commit)]).await else { return };
    let repo = repo_of(&f);
    let (_pid, _team, tid) = setup_ticket(&f, &repo, json!({})).await;
    // main moves the same line
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return b + a  # main\n").expect("calc.py");
    git(&repo, &["commit", "-qam", "main moved"]);
    let out = f.c.post_empty(&format!("/tickets/{tid}/ai/merge")).await.json();
    assert!(out["merged"] == false && out["conflict"] == json!(["calc.py"]), "{out}");
    assert!(!repo.join(".git").join("MERGE_HEAD").exists());
    assert!(std::fs::read_to_string(repo.join("calc.py")).expect("calc.py").contains("b + a  # main"));
    let wt = f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json();
    assert!(wt["state"] == "conflict" && wt["conflict_files"] == json!(["calc.py"]), "{wt}");
    let theirs =
        std::fs::read_to_string(Path::new(wt["path"].as_str().expect("path")).join("calc.py")).expect("calc.py");
    assert!(theirs.contains("a + b  # AI"));
    let panel = f.c.get("/notifications?view=panel&tab=needs").await.json();
    assert!(
        panel["items"]
            .as_array()
            .expect("items")
            .iter()
            .any(|i| i["kind"] == "merge_conflict" && i["title"].as_str().unwrap_or_default().contains(&tid)),
        "{panel}"
    );
}

#[tokio::test]
async fn test_merging_is_refused_while_the_main_checkout_is_dirty_or_on_another_branch() {
    let commit = "def add(a, b):\n    return a + b\n";
    let name = "test_merging_is_refused_while_the_main_checkout_is_dirty_or_on_another_branch";
    let Some((f, _keep)) = board(name, &[("FAKE_CLAUDE_COMMIT", commit)]).await else { return };
    let repo = repo_of(&f);
    let (_pid, _team, tid) = setup_ticket(&f, &repo, json!({})).await;
    std::fs::write(repo.join("notes.txt"), "mine, not committed").expect("notes");
    let out = f.c.post_empty(&format!("/tickets/{tid}/ai/merge")).await.json();
    assert!(out["merged"] == false && out["refused"].as_str().unwrap_or_default().contains("notes.txt"), "{out}");
    std::fs::remove_file(repo.join("notes.txt")).expect("remove");
    git(&repo, &["checkout", "-q", "-b", "elsewhere"]);
    let out = f.c.post_empty(&format!("/tickets/{tid}/ai/merge")).await.json();
    let refused = out["refused"].as_str().unwrap_or_default();
    assert!(out["merged"] == false && refused.contains("elsewhere") && refused.contains("main"), "{out}");
    git(&repo, &["checkout", "-q", "main"]);
    assert_eq!(f.c.post_empty(&format!("/tickets/{tid}/ai/merge")).await.json(), json!({"merged": true}));
    assert!(std::fs::read_to_string(repo.join("calc.py")).expect("calc.py").contains("a + b"));
}

#[tokio::test]
async fn test_merge_with_no_worktree_says_so() {
    let Some((f, _keep)) = board("test_merge_with_no_worktree_says_so", &[]).await else { return };
    let (pid, _) = project(&f.c).await;
    let tid = ticket(&f.c, &pid, "Fix add()", "todo").await;
    let out = f.c.post_empty(&format!("/tickets/{tid}/ai/merge")).await.json();
    assert!(out["merged"] == false && out["refused"].as_str().unwrap_or_default().contains("no worktree"), "{out}");
}

#[tokio::test]
async fn test_a_worktree_with_uncommitted_work_is_never_removed_and_commit_now_saves_it() {
    let Some((f, _keep)) =
        board("test_a_worktree_with_uncommitted_work_is_never_removed_and_commit_now_saves_it", &[]).await
    else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _team, tid) = setup_ticket(&f, &repo, json!({})).await;
    let wt = f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json();
    let path = PathBuf::from(wt["path"].as_str().expect("path"));
    std::fs::write(path.join("feature.py"), "x = 1\n").expect("feature.py");
    let live = f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json()["live"].clone();
    assert!(live["uncommitted"] == json!(["feature.py"]) && live["outputs"] == json!([]), "{live}");
    let r = f.c.post(&format!("/tickets/{tid}/ai/worktree/remove"), json!({})).await;
    assert!(r.status == 409 && r.json()["detail"].as_str().unwrap_or_default().contains("not committed"));
    let r = f.c.patch(&format!("/tickets/{tid}"), json!({"status": "wont_do", "wont_do_reason": "dropped"})).await;
    r.assert_status(200);
    let clean = f.c.post_empty(&format!("/projects/{pid}/ai/worktrees/cleanup")).await.json();
    assert!(clean["removed"] == json!([]) && clean["kept"][0]["ticket_id"] == json!(tid), "{clean}");
    let done = f.c.post_empty(&format!("/tickets/{tid}/ai/worktree/commit")).await.json();
    assert!(done["committed"] == true && done["left"] == json!([]), "{done}");
    assert_eq!(git(&path, &["status", "--porcelain"]), "");
    assert!(git(&path, &["log", "-1", "--format=%s"]).contains("committed by"));
    assert_eq!(f.c.post_empty(&format!("/tickets/{tid}/ai/worktree/commit")).await.json()["committed"], false);
    let clean = f.c.post_empty(&format!("/projects/{pid}/ai/worktrees/cleanup")).await.json();
    assert_eq!(clean["removed"], json!([tid]));
}

#[tokio::test]
async fn test_cleanup_removes_only_finished_tickets_and_a_kept_worktree_stays() {
    let Some((f, _keep)) = board("test_cleanup_removes_only_finished_tickets_and_a_kept_worktree_stays", &[]).await
    else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _team, tid) = setup_ticket(&f, &repo, json!({})).await;
    assert_eq!(
        f.c.post_empty(&format!("/projects/{pid}/ai/worktrees/cleanup")).await.json(),
        json!({"removed": [], "kept": []})
    );
    let wt = f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json();
    let r = f.c.patch(&format!("/tickets/{tid}"), json!({"status": "wont_do", "wont_do_reason": "dropped"})).await;
    r.assert_status(200);
    let kept = f.c.post_empty(&format!("/tickets/{tid}/ai/worktree/keep")).await;
    assert!(kept.status == 200 && kept.json()["state"] == "kept");
    assert_eq!(
        f.c.post_empty(&format!("/projects/{pid}/ai/worktrees/cleanup")).await.json(),
        json!({"removed": [], "kept": []})
    );
    assert!(Path::new(wt["path"].as_str().expect("path")).is_dir());
    // a kept worktree is still used by the next run, with the same port
    let again = f.c.get(&format!("/projects/{pid}/ai/worktrees")).await.json();
    let ports: Vec<&Value> = again["worktrees"].as_array().expect("worktrees").iter().map(|w| &w["port"]).collect();
    assert_eq!(ports, [&wt["port"]]);
    let other = ticket(&f.c, &pid, "No tree", "todo").await;
    assert_eq!(f.c.post_empty(&format!("/tickets/{other}/ai/worktree/keep")).await.status, 404);
}

#[tokio::test]
async fn test_the_handover_route_of_one_ticket_overrides_the_projects() {
    let Some((f, _keep)) = board("test_the_handover_route_of_one_ticket_overrides_the_projects", &[]).await else {
        return;
    };
    let repo = repo_of(&f);
    let (pid, _team, tid) = setup_ticket(&f, &repo, json!({})).await;
    let r = f.c.patch(&format!("/tickets/{tid}/ai/handover"), json!({"route": "branch"})).await;
    assert!(r.status == 200 && r.json()["route"] == "branch" && r.json()["handover"] == "branch", "{}", r.text());
    let r = f.c.patch(&format!("/tickets/{tid}/ai/handover"), json!({"route": "auto"})).await;
    // the project's choice
    assert!(r.json()["handover"].is_null() && r.json()["route"] == "local");
    let no = ticket(&f.c, &pid, "Other", "todo").await;
    assert_eq!(f.c.patch(&format!("/tickets/{no}/ai/handover"), json!({"route": "pr"})).await.status, 404);
}

#[tokio::test]
async fn test_review_with_a_branch_route_commits_leftovers_and_pushes_the_branch() {
    let name = "test_review_with_a_branch_route_commits_leftovers_and_pushes_the_branch";
    let Some((f, _keep)) = board(name, &[]).await else { return };
    let repo = repo_of(&f);
    let bare = tmp(&f).join("remote.git");
    git(&tmp(&f), &["init", "-q", "--bare", &bare.to_string_lossy()]);
    git(&repo, &["remote", "add", "origin", &bare.to_string_lossy()]);
    let (_pid, _team, tid) = setup_ticket(&f, &repo, json!({"handover": "branch"})).await;
    let wt = f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json();
    let path = PathBuf::from(wt["path"].as_str().expect("path"));
    std::fs::write(path.join("late.py"), "y = 2\n").expect("late.py");
    // the Python test calls `worktrees.on_review`; a person moving the ticket to Review is what calls it
    f.c.patch(&format!("/tickets/{tid}"), json!({"status": "review"})).await.assert_status(200);
    let branch = wt["branch"].as_str().expect("branch").to_string();
    until("the branch is pushed", async || git(&bare, &["branch", "--list"]).contains(&branch)).await;
    assert!(git(&bare, &["log", &branch, "-1", "--format=%s"]).contains("work in progress handed over for review"));
    assert!(path.join("late.py").exists() && git(&path, &["status", "--porcelain"]).is_empty());
}

#[tokio::test]
async fn test_outputs_a_run_leaves_are_tidied_at_its_end_and_never_committed() {
    let leave = json!(["feature.py", "shot.png", "qa/step.txt"]).to_string();
    let name = "test_outputs_a_run_leaves_are_tidied_at_its_end_and_never_committed";
    let Some((f, _keep)) = board(name, &[("FAKE_CLAUDE_LEAVE", &leave)]).await else { return };
    let repo = repo_of(&f);
    let (_pid, _team, tid) = setup_ticket(&f, &repo, json!({})).await;
    let wt = f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json();
    let path = PathBuf::from(wt["path"].as_str().expect("path"));
    // the end of the run tidied the worktree and said where the outputs went
    let note_of = async || -> Option<String> {
        let ticket_now = f.c.get(&format!("/tickets/{tid}")).await.json();
        let log = ticket_now.get("work_log").and_then(Value::as_array).cloned().unwrap_or_default();
        log.iter().filter_map(|e| e["note"].as_str()).find(|n| n.contains("output file")).map(str::to_string)
    };
    until("the outputs are told", async || note_of().await.is_some()).await;
    let note = note_of().await.expect("a note");
    if note.starts_with("Moved 2 output files") {
        // the Workspace is on: the ticket's folder has them
        assert!(!path.join("shot.png").exists() && !path.join("qa").exists());
        assert_eq!(f.c.get(&format!("/tickets/{tid}/ai/worktree")).await.json()["live"]["outputs"], json!([]));
    } else {
        // the Workspace is off: they stay, and the note says why the worktree is not clean
        assert!(note.contains("still in the worktree") && path.join("shot.png").exists(), "{note}");
    }
    // whichever it was, the code is committed on a person's request and the outputs never are
    let done = f.c.post_empty(&format!("/tickets/{tid}/ai/worktree/commit")).await.json();
    assert_eq!(done["committed"], true);
    let shown = git(&path, &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(shown.split_whitespace().collect::<Vec<_>>(), vec!["feature.py"]);
}
