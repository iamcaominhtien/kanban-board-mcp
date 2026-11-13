//! More of `worktrees` than the Python suite covers (`server/tests/test_ai_worktrees_v2.py` is ported in
//! `test_ai_worktrees_v2.rs`): the pull request opened with `gh` (a fake `gh` on the `PATH`, nothing reaches GitHub), the
//! merge on the `pr` and `branch` routes, the outputs when the Workspace is off, what the ticket's moves start and what
//! they ignore, the seam of `kb-ai` this crate fills, and the helpers the MCP view adapter calls.

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_ai::context::RunContext;
use kb_ai_work::worktrees::{self, Handover};
use kb_db::database;
use kb_db::entities::{ai_worktree, ticket, workspace_settings};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel};
use serde_json::{Value, json};

async fn setup(name: &str, extra: Value) -> (std::path::PathBuf, String, ticket::Model, ai_worktree::Model) {
    let repo = common::repo(name);
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, extra).await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    let row = common::ensure_worktree(&t, &repo).await.expect("ensure").expect("a worktree");
    (repo, pid, t, row)
}

async fn row_of(tid: &str) -> ai_worktree::Model {
    let session = database::session();
    ai_worktree::Entity::find_by_id(tid).one(&session).await.expect("read").expect("a row")
}

#[tokio::test]
async fn a_pull_request_is_opened_as_a_draft_with_gh_and_recorded() {
    let _g = common::init().await;
    common::fake_gh_reset();
    let (repo, _pid, t, row) = setup("pr-open", json!({"handover": "pr"})).await;
    let bare = common::bare_remote(&repo, "pr-open");
    common::fake_gh_set(
        "pr_create",
        "Creating draft pull request for ai/x into main\nhttps://github.com/o/r/pull/42\n",
        "",
        0,
    );
    std::fs::write(Path::new(&row.path).join("late.py"), "y = 2\n").expect("late");
    let out = worktrees::on_review(&t.id).await.expect("review").expect("a result");
    assert_eq!(out, json!({"route": "pr", "pr_url": "https://github.com/o/r/pull/42"}));
    let stored = row_of(&t.id).await;
    assert_eq!((stored.pr_url.as_deref(), stored.pr_number), (Some("https://github.com/o/r/pull/42"), Some(42)));
    assert!(common::git(&bare, &["branch", "--list"]).contains(&row.branch));
    let calls = common::fake_gh_calls();
    assert_eq!(calls.len(), 1);
    let want = format!(
        "|pr create --draft --head {} --base main --title {}: Fix add() --body Opened by the Kanban board for {}. It becomes ready for review when the ticket reaches Done.",
        row.branch, t.id, t.id
    );
    assert!(calls[0].ends_with(&want) && calls[0].starts_with(&row.path), "{}", calls[0]);
    // asked again: the branch is pushed again and no second pull request is made
    let again = worktrees::on_review(&t.id).await.expect("review");
    assert_eq!(again, Some(json!({"route": "pr", "pushed": true})));
    assert_eq!(common::fake_gh_calls().len(), 1);
}

#[tokio::test]
async fn a_pull_request_gh_cannot_make_is_reported() {
    let _g = common::init().await;
    common::fake_gh_reset();
    let (repo, _pid, t, _row) = setup("pr-fails", json!({"handover": "pr"})).await;
    common::bare_remote(&repo, "pr-fails");
    common::fake_gh_set("pr_create", "", "GraphQL: not allowed\n", 1);
    let out = worktrees::on_review(&t.id).await.expect("review").expect("a result");
    assert_eq!(out, json!({"route": "pr", "error": "gh pr create failed: GraphQL: not allowed"}));
    assert!(row_of(&t.id).await.pr_url.is_none());
}

#[tokio::test]
async fn on_the_pr_route_a_merge_marks_the_pull_request_ready_and_merges_nothing() {
    let _g = common::init().await;
    common::fake_gh_reset();
    let (_repo, _pid, t, row) = setup("pr-ready", json!({"handover": "pr"})).await;
    // a worktree without a pull request: nothing to mark
    let out = worktrees::merge(&t.id, "An").await.expect("merge");
    assert_eq!(out, json!({"merged": false, "pr_ready": false, "pr_url": null}));
    assert!(common::fake_gh_calls().is_empty());
    let session = database::session();
    let mut own = row.clone();
    own.pr_number = Some(42);
    own.pr_url = Some("https://github.com/o/r/pull/42".into());
    own.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    common::fake_gh_set("pr_ready", "", "", 0);
    let out = worktrees::merge(&t.id, "An").await.expect("merge");
    assert_eq!(out, json!({"merged": false, "pr_ready": true, "pr_url": "https://github.com/o/r/pull/42"}));
    let calls = common::fake_gh_calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].ends_with("|pr ready 42") && calls[0].starts_with(&row.path), "{}", calls[0]);
}

#[tokio::test]
async fn on_the_branch_route_a_merge_pushes_the_branch() {
    let _g = common::init().await;
    let (repo, _pid, t, row) = setup("branch-merge", json!({"handover": "branch"})).await;
    let bare = common::bare_remote(&repo, "branch-merge");
    std::fs::write(Path::new(&row.path).join("done.py"), "d = 1\n").expect("file");
    assert_eq!(worktrees::merge(&t.id, "An").await.expect("merge"), json!({"merged": false, "pushed": true}));
    assert!(common::git(&bare, &["branch", "--list"]).contains(&row.branch));
    assert!(common::git(&bare, &["log", &row.branch, "-1", "--format=%s"]).contains(&format!("{}: done", t.id)));
}

#[tokio::test]
async fn the_route_is_guessed_from_a_github_remote_and_a_signed_in_gh() {
    let _g = common::init().await;
    common::fake_gh_reset();
    let repo = common::repo("guess-github");
    common::git(&repo, &["remote", "add", "origin", "git@github.com:o/r.git"]);
    let text = repo.to_string_lossy().into_owned();
    common::fake_gh_set("auth_status", "", "You are not logged in\n", 1);
    assert_eq!(worktrees::guess_route(&text).await.expect("route"), "branch");
    common::fake_gh_set("auth_status", "Logged in\n", "", 0);
    assert_eq!(worktrees::guess_route(&text).await.expect("route"), "pr");
    assert!(common::fake_gh_calls().iter().all(|c| c.ends_with("|auth status")));
}

/// Turn the Workspace on or off for the board.
async fn workspace(enabled: bool) {
    let session = database::session();
    let settings = kb_board::workspace::get_workspace_settings(&session).await.expect("settings");
    let mut active = workspace_settings::Entity::find_by_id(settings.id)
        .one(&session)
        .await
        .expect("read")
        .expect("row")
        .into_active_model();
    active.enabled = Set(enabled);
    active.update(&session).await.expect("update");
    session.commit().await.expect("commit");
}

async fn work_log_notes(tid: &str) -> Vec<String> {
    let session = database::session();
    let row = ticket::Entity::find_by_id(tid).one(&session).await.expect("read").expect("ticket");
    serde_json::from_str::<Vec<Value>>(&row.work_log)
        .unwrap_or_default()
        .iter()
        .filter_map(|e| e["note"].as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
async fn with_the_workspace_off_outputs_stay_and_are_left_out_of_the_commit() {
    let _g = common::init().await;
    workspace(false).await;
    let (_repo, _pid, t, row) = setup("ws-off", json!({})).await;
    for rel in ["feature.py", "shot.png", "qa/step.txt"] {
        let path = Path::new(&row.path).join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        std::fs::write(path, "x").expect("file");
    }
    let moved = worktrees::move_outputs(&t.id).await.expect("move");
    assert_eq!(
        moved.to_value(),
        json!({"moved": [], "left": ["qa/step.txt", "shot.png"], "reason": "Workspace is off (Settings › Workspace), so they stay in the worktree."})
    );
    worktrees::log_tidy(&t.id, &moved, Some("An")).await.expect("log");
    let notes = work_log_notes(&t.id).await;
    assert_eq!(notes.len(), 1);
    assert!(notes[0].starts_with("2 output files the run left are still in the worktree `"), "{}", notes[0]);
    assert!(notes[0].contains("(Workspace is off (Settings › Workspace), so they stay in the worktree.):\n- `qa/step.txt`\n- `shot.png`\n\nThey keep the worktree from being cleaned"));
    // committing the code leaves them out
    let done = worktrees::commit_now(&t.id, "An").await.expect("commit");
    assert_eq!(done, json!({"committed": true, "left": ["qa/step.txt", "shot.png"]}));
    let shown = common::git(Path::new(&row.path), &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(shown.split_whitespace().collect::<Vec<_>>(), vec!["feature.py"]);
    assert!(Path::new(&row.path).join("shot.png").exists());
    // a worktree that was never made has nothing to move
    assert_eq!(
        worktrees::move_outputs("T-nobody").await.expect("move").to_value()["reason"],
        "This ticket has no worktree."
    );
    workspace(true).await;
}

#[tokio::test]
async fn a_run_waiting_for_an_answer_or_a_busy_worktree_is_not_tidied() {
    let _g = common::init().await;
    workspace(true).await;
    let (_repo, pid, t, row) = setup("tidy-skips", json!({})).await;
    let (team, _) = common::team(&pid, "Claude Code · QA", Default::default()).await;
    std::fs::write(Path::new(&row.path).join("shot.png"), "x").expect("file");
    let waiting = common::run(&pid, &team.id, Some(&t.id), "needs_input", |_| {}).await;
    assert!(worktrees::tidy_after_run(&t.id, &waiting.id).await.expect("tidy").is_none());
    assert!(Path::new(&row.path).join("shot.png").exists());
    // another run works in the worktree now: it tidies when it ends
    let busy = common::run(&pid, &team.id, Some(&t.id), "running", |_| {}).await;
    let ended = common::run(&pid, &team.id, Some(&t.id), "finished", |_| {}).await;
    assert!(worktrees::tidy_after_run(&t.id, &ended.id).await.expect("tidy").is_none());
    common::set_run_state(&busy.id, "finished").await;
    let result = worktrees::tidy_after_run(&t.id, &ended.id).await.expect("tidy").expect("tidied");
    assert_eq!(result.moved(), ["shot.png".to_string()]);
    assert!(
        work_log_notes(&t.id).await.iter().any(|n| n.starts_with("Moved 1 output file the run left in the worktree"))
    );
    // no worktree, or no run
    assert!(worktrees::tidy_after_run("T-nobody", &ended.id).await.expect("tidy").is_none());
    assert!(worktrees::tidy_after_run(&t.id, "run-nobody").await.expect("tidy").is_none());
}

#[tokio::test]
async fn ensure_uses_the_project_settings_for_the_repository_and_the_base_branch() {
    let _g = common::init().await;
    let repo = common::repo("ensure-settings");
    common::git(&repo, &["branch", "develop"]);
    let (pid, _) = common::project().await;
    let elsewhere = common::folder().join("repos").join("not-a-repo");
    std::fs::create_dir_all(&elsewhere).expect("folder");
    // the setting names the repository, whatever folder the team works in
    common::worktrees_on(&pid, json!({"repo": repo.to_string_lossy(), "base_branch": "develop"})).await;
    let t = common::ticket(&pid, "Plan the 'release' now", "todo").await;
    let row = common::ensure_worktree(&t, &elsewhere).await.expect("ensure").expect("a worktree");
    assert_eq!((row.base.as_str(), row.repo.as_str()), ("develop", repo.to_string_lossy().as_ref()));
    assert_eq!(row.branch, format!("ai/{}-plan-the-release-now", t.id));
    assert!(common::git(&repo, &["branch", "--list", &row.branch]).contains(&row.branch));
    // a folder of an earlier session is used as it is
    let session = database::session();
    let mut gone = row.clone();
    gone.state = "removed".into();
    gone.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    let again = worktrees::ensure(&session, &t, None).await.expect("ensure").expect("a worktree");
    assert_eq!((again.state.as_str(), again.path.as_str(), again.port), ("active", row.path.as_str(), row.port));
    // the shared folder names its own repository when the setting does not
    let none = worktrees::ensure(&session, &t, Some("/definitely/not/a/folder")).await.expect("ensure");
    assert!(none.is_some(), "the settings repo wins");
}

#[tokio::test]
async fn every_port_taken_is_a_board_fault() {
    let _g = common::init().await;
    let repo = common::repo("ports-full");
    let (pid, _) = common::project().await;
    // a base port far from the others of this file's database
    common::worktrees_on(&pid, json!({"base_port": 7100})).await;
    let mut last = None;
    for i in 0..21 {
        let t = common::ticket(&pid, &format!("Ticket {i}"), "todo").await;
        last = Some(common::ensure_worktree(&t, &repo).await);
    }
    let err = last.expect("a result").expect_err("the twenty-first has no port");
    assert!(err.is_worktree_error());
    assert_eq!(err.to_string(), "Every port from 7100 to 7119 is taken by a worktree.");
}

/// What the Python tests monkeypatch: the hand-over calls.
#[derive(Default)]
struct Spy {
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl Handover for Spy {
    async fn on_review(&self, ticket_id: &str) -> Result<Option<Value>, worktrees::Error> {
        self.seen.lock().expect("lock").push(format!("review {ticket_id}"));
        Ok(None)
    }

    async fn merge(&self, ticket_id: &str, by: &str) -> Result<Value, worktrees::Error> {
        self.seen.lock().expect("lock").push(format!("merge {ticket_id} by {by}"));
        Ok(json!({}))
    }
}

#[tokio::test]
async fn a_board_ai_move_hands_nothing_over() {
    let _g = common::init().await;
    worktrees::clear_deferred();
    let spy = Arc::new(Spy::default());
    worktrees::set_handover(Some(spy.clone()));
    // a change a person applies from a Board AI draft ("suggested by")
    kb_base::ctx::scope(async {
        let _token = kb_base::activity::set_suggested(Some("Board AI"));
        worktrees::on_status("T-1", "review", "in-progress", false);
        // Done is always asked first: a person confirmed that one
        worktrees::on_status("T-1", "done", "review", false);
    })
    .await;
    // the Board AI's own chat
    kb_base::ctx::scope(async {
        let context = RunContext {
            run_id: "r".into(),
            trigger: "assistant".into(),
            project_id: "p".into(),
            ..RunContext::default()
        };
        let tokens = kb_ai::guard::enter(&context);
        worktrees::on_status("T-2", "review", "in-progress", false);
        kb_ai::guard::leave(tokens);
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let seen = spy.seen.lock().expect("lock").clone();
    worktrees::set_handover(None);
    assert_eq!(seen, vec!["merge T-1 by person".to_string()]);
}

/// A previous `TicketRuns`, as `runs` will be.
#[derive(Default)]
struct Previous {
    edits: Mutex<Vec<String>>,
}

#[async_trait]
impl kb_ai::seams::TicketRuns for Previous {
    async fn before_ticket_change(
        &self,
        ticket_id: &str,
        _status: Option<&str>,
        _assignee: kb_board::hooks::NewAssignee<'_>,
        _deleting: bool,
        _by: &str,
    ) -> kb_base::ApiResult<()> {
        self.edits.lock().expect("lock").push(format!("before {ticket_id}"));
        Ok(())
    }

    async fn note_person_edit(&self, ticket_id: &str, by: &str, what: &str, tell_lead: bool) -> kb_base::ApiResult<()> {
        self.edits.lock().expect("lock").push(format!("edit {ticket_id} {by} {what} {tell_lead}"));
        Ok(())
    }

    async fn wake_new_assignee(&self, ticket_id: &str, assignee_id: &str, by: &str) -> kb_base::ApiResult<()> {
        self.edits.lock().expect("lock").push(format!("wake {ticket_id} {assignee_id} {by}"));
        Ok(())
    }

    fn on_status(&self, _ticket_id: &str, _status: &str, _previous: &str, _by_ai: bool) {
        self.edits.lock().expect("lock").push("previous on_status".into());
    }
}

#[tokio::test]
async fn register_fills_the_status_seam_and_keeps_what_was_there() {
    let _g = common::init().await;
    worktrees::clear_deferred();
    let previous = Arc::new(Previous::default());
    kb_ai::seams::set_ticket_runs(Some(previous.clone()));
    kb_ai_work::register();
    let spy = Arc::new(Spy::default());
    worktrees::set_handover(Some(spy.clone()));
    let runs = kb_ai::seams::ticket_runs().expect("the seam is filled");
    runs.on_status("T-9", "done", "review", false);
    runs.note_person_edit("T-9", "An", "title", true).await.expect("edit");
    runs.wake_new_assignee("T-9", "m1", "An").await.expect("wake");
    common::until(10, || async { !spy.seen.lock().expect("lock").is_empty() }).await;
    worktrees::set_handover(None);
    kb_ai::seams::set_ticket_runs(None);
    assert_eq!(spy.seen.lock().expect("lock").clone(), vec!["merge T-9 by person".to_string()]);
    // the other calls went to what was registered before, and its own `on_status` was not called
    assert_eq!(
        previous.edits.lock().expect("lock").clone(),
        vec!["edit T-9 An title true".to_string(), "wake T-9 m1 An".to_string()]
    );
    // without anything registered before they do nothing
    kb_ai_work::register();
    let runs = kb_ai::seams::ticket_runs().expect("the seam is filled");
    runs.note_person_edit("T-9", "An", "title", true).await.expect("edit");
    kb_ai::seams::set_ticket_runs(None);
}

#[tokio::test]
async fn the_brief_of_a_ticket_for_the_mcp_view_says_what_is_not_committed() {
    let _g = common::init().await;
    let (_repo, _pid, t, row) = setup("brief", json!({})).await;
    assert_eq!(worktrees::worktree_brief("T-nobody").await.expect("brief"), None);
    let clean = worktrees::worktree_brief(&t.id).await.expect("brief").expect("a brief");
    assert_eq!(
        clean,
        json!({"path": row.path, "branch": row.branch, "state": "active", "exists": true, "uncommitted": [], "outputs": []})
    );
    std::fs::write(Path::new(&row.path).join("shot.png"), "x").expect("file");
    std::fs::write(Path::new(&row.path).join("code.py"), "x").expect("file");
    let busy = worktrees::worktree_brief(&t.id).await.expect("brief").expect("a brief");
    assert_eq!(busy["uncommitted"], json!(["code.py", "shot.png"]));
    assert_eq!(
        busy["note"],
        "2 files not committed, 1 of them outputs (screenshots, logs, reports): the worktree is not removed until a person commits, moves or discards them."
    );
    // a removed worktree has no brief
    let session = database::session();
    let mut gone = row_of(&t.id).await;
    gone.state = "removed".into();
    gone.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    assert_eq!(worktrees::worktree_brief(&t.id).await.expect("brief"), None);
}

#[tokio::test]
async fn a_hand_over_that_fails_never_disturbs_the_board() {
    let _g = common::init().await;
    worktrees::clear_deferred();
    // a ticket with no worktree: Review and Done find nothing to hand over, and nothing panics
    let (pid, _) = common::project().await;
    let t = common::ticket(&pid, "Nothing to hand over", "review").await;
    worktrees::on_status(&t.id, "review", "in-progress", false);
    worktrees::on_status(&t.id, "done", "review", false);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(row_opt(&t.id).await.is_none());
}

async fn row_opt(tid: &str) -> Option<ai_worktree::Model> {
    let session = database::session();
    ai_worktree::Entity::find_by_id(tid).one(&session).await.expect("read")
}
