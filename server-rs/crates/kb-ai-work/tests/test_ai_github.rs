//! `github` (`services/ai/github.py`): the watcher of the pull requests the board opened. The Python suite has no test for
//! it; these run the whole module against a fake `gh` (a script on the `PATH` that answers what the test prepared and
//! logs its calls, see `common`) and a fake `runs` seam, so nothing reaches GitHub or starts a CLI.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use kb_ai_work::{github, seams};
use kb_db::database;
use kb_db::entities::{ai_run, ai_watched_pr, ai_worktree};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel};
use serde_json::{Value, json};

/// What `runs.deliver_to_ticket` is replaced by: it records the call and answers with a run that exists.
#[derive(Default)]
struct FakeRuns {
    calls: Mutex<Vec<(String, String, String, String)>>,
    answer: Mutex<Value>,
}

#[async_trait]
impl seams::Runs for FakeRuns {
    async fn deliver_to_ticket(&self, ticket_id: &str, text: &str, by: &str, trigger: &str) -> Result<Value, String> {
        self.calls.lock().expect("lock").push((ticket_id.into(), text.into(), by.into(), trigger.into()));
        Ok(self.answer.lock().expect("lock").clone())
    }
}

struct Seam(Arc<FakeRuns>);

impl Seam {
    fn new(answer: Value) -> Self {
        let runs = Arc::new(FakeRuns::default());
        *runs.answer.lock().expect("lock") = answer;
        seams::set_runs(Some(runs.clone()));
        Seam(runs)
    }
}

impl Drop for Seam {
    fn drop(&mut self) {
        seams::set_runs(None);
    }
}

struct Fixture {
    pid: String,
    tid: String,
    member: String,
    repo: String,
}

/// A project with GitHub on, a ticket with a worktree whose pull request is #7, and a Dev's run on the ticket.
async fn fixture(extra_github: Value) -> Fixture {
    common::fake_gh_reset();
    let (pid, _) = common::project().await;
    let mut cfg = json!({"on": true, "poll_min": 5, "auto": true});
    for (k, v) in extra_github.as_object().expect("an object") {
        cfg[k] = v.clone();
    }
    common::set_ops(&pid, json!({"github": cfg})).await;
    let (member, _) = common::team(&pid, "Claude Code · Dev", Default::default()).await;
    let t = common::ticket(&pid, "Fix add()", "review").await;
    let repo = common::folder().join("repos").join(format!("gh-{}", t.id));
    std::fs::create_dir_all(&repo).expect("repo folder");
    let session = database::session();
    let mut wt = ai_worktree::new();
    wt.ticket_id = Set(t.id.clone());
    wt.project_id = Set(pid.clone());
    wt.repo = Set(repo.to_string_lossy().into_owned());
    wt.path = Set(repo.join("wt").to_string_lossy().into_owned());
    wt.branch = Set(format!("ai/{}-fix-add", t.id));
    wt.pr_number = Set(Some(7));
    wt.pr_url = Set(Some("https://github.com/o/r/pull/7".into()));
    wt.insert(&session).await.expect("worktree");
    session.commit().await.expect("commit");
    common::run(&pid, &member.id, Some(&t.id), "finished", |r| r.mode = Set("work".into())).await;
    Fixture { pid, tid: t.id, member: member.id, repo: repo.to_string_lossy().into_owned() }
}

fn red_view() -> String {
    json!({
        "state": "OPEN",
        "statusCheckRollup": [{"conclusion": "FAILURE", "status": "COMPLETED", "name": "build", "workflowName": "CI",
                               "detailsUrl": "https://github.com/o/r/actions/runs/12345678/job/1"}],
        "reviews": [], "comments": [], "headRefName": "ai/x", "baseRefName": "main", "url": "https://github.com/o/r/pull/7",
    })
    .to_string()
}

async fn watched(tid: &str) -> ai_watched_pr::Model {
    let session = database::session();
    ai_watched_pr::Entity::find_by_id(tid).one(&session).await.expect("read").expect("a watched pull request")
}

async fn a_run_row(pid: &str, member: &str, tid: &str, trigger: &str) -> ai_run::Model {
    common::run(pid, member, Some(tid), "queued", |r| r.trigger = Set(trigger.into())).await
}

#[tokio::test]
async fn watch_new_starts_watching_each_pull_request_the_board_opened_once() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    let session = database::session();
    assert!(github::watch_new(&session).await.expect("watch") >= 1);
    let row = watched(&f.tid).await;
    assert_eq!((row.number, row.state.as_str(), row.project_id.as_str()), (7, "open", f.pid.as_str()));
    assert_eq!(row.url.as_deref(), Some("https://github.com/o/r/pull/7"));
    assert_eq!(row.repo, f.repo);
    assert_eq!(github::watch_new(&session).await.expect("watch"), 0);
}

#[tokio::test]
async fn red_ci_the_change_caused_is_blamed_and_goes_back_to_the_dev_with_its_log() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    common::fake_gh_set("pr_view", &red_view(), "", 0);
    common::fake_gh_set("run_list", r#"[{"workflowName": "CI", "conclusion": "success"}]"#, "", 0);
    common::fake_gh_set("run_view", "the failing step says boom {x}", "", 0);
    let changes = github::tick_project(&f.pid).await.expect("tick");
    assert_eq!(changes, vec![json!({"kind": "ci_red", "ticket_id": f.tid, "check": "build", "blamed": true})]);
    let row = watched(&f.tid).await;
    assert_eq!(row.ci.as_deref(), Some("red"));
    assert!(row.checked_at.is_some() && row.last_error.is_none());
    let red: Value = serde_json::from_str(row.red.as_deref().expect("red")).expect("json");
    assert_eq!(
        (red["check"].clone(), red["workflow"].clone(), red["blamed"].clone(), red["base_unknown"].clone(), red["base"].clone()),
        (json!("build"), json!("CI"), json!(true), json!(false), json!("main"))
    );
    assert_eq!(red["url"], "https://github.com/o/r/actions/runs/12345678/job/1");
    // the card
    let session = database::session();
    let signals = github::signals(&session, &f.pid).await.expect("signals");
    assert_eq!(signals.len(), 1);
    assert_eq!(signals[0]["title"], format!("CI failed on {}'s pull request #7: build", f.tid));
    assert_eq!(signals[0]["detail"], "The same check is green on main, so it is this change.");
    assert_eq!(signals[0]["score"], 8);
    // the board gives it to the team
    let run = a_run_row(&f.pid, &f.member, &f.tid, "ci_red").await;
    let seam = Seam::new(json!({"run_id": run.id, "delivered": "started"}));
    let got = github::back_to_dev(&changes[0]).await.expect("back to dev");
    assert_eq!(got.as_deref(), Some(run.id.as_str()));
    let calls = seam.0.calls.lock().expect("lock").clone();
    assert_eq!(calls.len(), 1);
    assert_eq!((calls[0].0.as_str(), calls[0].2.as_str(), calls[0].3.as_str()), (f.tid.as_str(), "the board (red CI)", "ci_red"));
    assert!(calls[0].1.starts_with("CI failed on the pull request #7 of this ticket (build). The same check is green on main"));
    assert!(calls[0].1.contains("<untrusted source=\"ci log · build\">\nthe failing step says boom {x}\n</untrusted>"), "{}", calls[0].1);
    let after: Value = serde_json::from_str(watched(&f.tid).await.red.as_deref().expect("red")).expect("json");
    assert_eq!((after["run_id"].clone(), after["delivered"].clone()), (json!(run.id), json!("started")));
    assert!(after["handled_at"].is_string());
    // handled: nothing more goes out, and the card is gone
    assert_eq!(github::back_to_dev(&changes[0]).await.expect("back to dev"), None);
    assert_eq!(seam.0.calls.lock().expect("lock").len(), 1);
    assert!(github::signals(&session, &f.pid).await.expect("signals").is_empty());
    // the log was asked for with the run id of the check's link
    assert!(common::fake_gh_calls().iter().any(|c| c.ends_with("|run view 12345678 --log-failed")));
}

#[tokio::test]
async fn red_ci_that_is_red_on_the_base_too_waits_for_a_person() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    common::fake_gh_set("pr_view", &red_view(), "", 0);
    common::fake_gh_set("run_list", r#"[{"workflowName": "CI", "conclusion": "failure"}]"#, "", 0);
    let changes = github::tick_project(&f.pid).await.expect("tick");
    assert_eq!(changes, vec![json!({"kind": "ci_red", "ticket_id": f.tid, "check": "build", "blamed": false})]);
    let red: Value = serde_json::from_str(watched(&f.tid).await.red.as_deref().expect("red")).expect("json");
    assert_eq!((red["blamed"].clone(), red["base_unknown"].clone()), (json!(false), json!(false)));
    let session = database::session();
    assert!(github::signals(&session, &f.pid).await.expect("signals").is_empty());
    // the board does not act on it, whatever `auto` says
    let seam = Seam::new(json!({}));
    github::act(&f.pid, &changes).await.expect("act");
    assert!(seam.0.calls.lock().expect("lock").is_empty());
}

#[tokio::test]
async fn nobody_is_blamed_on_a_guess() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    // gh cannot say how the base branch is doing
    common::fake_gh_set("pr_view", &red_view(), "", 0);
    common::fake_gh_set("run_list", "", "no runs", 1);
    let changes = github::tick_project(&f.pid).await.expect("tick");
    assert_eq!(changes[0]["blamed"], json!(false));
    let red: Value = serde_json::from_str(watched(&f.tid).await.red.as_deref().expect("red")).expect("json");
    assert_eq!(red["base_unknown"], json!(true));
}

#[tokio::test]
async fn review_comments_of_people_go_to_the_dev_and_the_boards_own_replies_do_not_come_back() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    let view = json!({
        "state": "OPEN", "statusCheckRollup": [], "headRefName": "ai/x", "baseRefName": "main",
        "comments": [
            {"id": "IC_1", "author": {"login": "bob"}, "body": "please rename", "createdAt": "2026-01-01T00:00:00Z"},
            {"id": "IC_2", "author": {"login": "me"}, "body": "done\n<!-- kanban-board-ai -->", "createdAt": "2026-01-01T00:00:01Z"},
            {"id": "IC_3", "author": {"login": "ci[bot]"}, "body": "bump", "createdAt": "2026-01-01T00:00:02Z"},
        ],
        "reviews": [{"id": "R_1", "author": {"login": "carol"}, "body": "wrong", "path": "a.py", "line": 3, "createdAt": "x"}],
    });
    common::fake_gh_set("pr_view", &view.to_string(), "", 0);
    let changes = github::tick_project(&f.pid).await.expect("tick");
    assert_eq!(changes, vec![json!({"kind": "review_comments", "ticket_id": f.tid, "count": 2})]);
    let row = watched(&f.tid).await;
    assert_eq!(row.ci.as_deref(), Some("none"));
    let pending: Vec<Value> = serde_json::from_str(&row.pending_comments).expect("json");
    assert_eq!(pending.iter().map(|c| c["id"].as_str().unwrap_or("")).collect::<Vec<_>>(), vec!["IC_1", "R_1"]);
    let seen: Vec<String> = serde_json::from_str(&row.seen_comments).expect("json");
    assert_eq!(seen, vec!["IC_1".to_string(), "R_1".to_string()]);
    // given to the Dev: fenced, marked as given
    let run = a_run_row(&f.pid, &f.member, &f.tid, "review_comments").await;
    let seam = Seam::new(json!({"run_id": run.id, "delivered": "message"}));
    assert_eq!(github::comments_to_dev(&f.tid).await.expect("to dev").as_deref(), Some(run.id.as_str()));
    let calls = seam.0.calls.lock().expect("lock").clone();
    assert_eq!((calls[0].2.as_str(), calls[0].3.as_str()), ("the board (review comments)", "review_comments"));
    assert!(calls[0].1.contains("<untrusted source=\"review comment · @bob\">\nplease rename\n</untrusted>"));
    assert!(calls[0].1.contains("<untrusted source=\"review comment · @carol · a.py:3\">\nwrong\n</untrusted>"));
    assert!(calls[0].1.contains("end every reply with the line `<!-- kanban-board-ai -->` exactly"));
    let given: Vec<Value> = serde_json::from_str(&watched(&f.tid).await.pending_comments).expect("json");
    assert!(given.iter().all(|c| c["run_id"] == json!(run.id) && c["delivered"] == json!("message") && c["handled_at"].is_string()));
    // nothing waits now
    assert_eq!(github::comments_to_dev(&f.tid).await.expect("to dev"), None);
    // a later batch drops the ones already given, and the seen ones never come back
    let later = json!({
        "state": "OPEN", "statusCheckRollup": [], "headRefName": "ai/x", "baseRefName": "main", "reviews": [],
        "comments": [{"id": "IC_1", "author": {"login": "bob"}, "body": "again"}, {"id": "IC_4", "author": {"login": "dan"}, "body": "new"}],
    });
    common::fake_gh_set("pr_view", &later.to_string(), "", 0);
    // not due yet: the poll waits for poll_min
    assert!(github::tick_project(&f.pid).await.expect("tick").is_empty());
    let mut row = watched(&f.tid).await;
    row.checked_at = Some("2020-01-01T00:00:00+00:00".into());
    let session = database::session();
    row.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    let changes = github::tick_project(&f.pid).await.expect("tick");
    assert_eq!(changes, vec![json!({"kind": "review_comments", "ticket_id": f.tid, "count": 1})]);
    let pending: Vec<Value> = serde_json::from_str(&watched(&f.tid).await.pending_comments).expect("json");
    assert_eq!(pending.iter().map(|c| c["id"].as_str().unwrap_or("")).collect::<Vec<_>>(), vec!["IC_4"]);
}

#[tokio::test]
async fn a_pull_request_is_polled_only_when_it_is_due_and_a_gh_failure_is_kept() {
    let _g = common::init().await;
    let f = fixture(json!({"poll_min": 10})).await;
    common::fake_gh_set("pr_view", "", "HTTP 502\n", 1);
    assert!(github::tick_project(&f.pid).await.expect("tick").is_empty());
    let row = watched(&f.tid).await;
    assert_eq!(row.last_error.as_deref(), Some("HTTP 502"));
    assert!(row.checked_at.is_some());
    let polls = || common::fake_gh_calls().iter().filter(|c| c.contains("|pr view 7 ")).count();
    assert_eq!(polls(), 1);
    // asked again at once: not due
    github::tick_project(&f.pid).await.expect("tick");
    assert_eq!(polls(), 1);
    assert!(common::fake_gh_calls()[0].ends_with("|pr view 7 --json state,statusCheckRollup,reviews,comments,headRefName,baseRefName,url"));
    // the pull request is merged: it is closed and watched no more
    let mut row = watched(&f.tid).await;
    row.checked_at = Some("2020-01-01T00:00:00+00:00".into());
    let session = database::session();
    row.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    common::fake_gh_set("pr_view", &json!({"state": "MERGED", "statusCheckRollup": [{"conclusion": "SUCCESS"}]}).to_string(), "", 0);
    github::tick_project(&f.pid).await.expect("tick");
    let row = watched(&f.tid).await;
    assert_eq!((row.state.as_str(), row.ci.as_deref(), row.last_error.as_deref()), ("closed", Some("green"), None));
    github::tick_project(&f.pid).await.expect("tick");
    assert_eq!(polls(), 2);
}

#[tokio::test]
async fn a_project_with_github_off_is_not_polled() {
    let _g = common::init().await;
    let f = fixture(json!({"on": false})).await;
    assert!(github::tick_project(&f.pid).await.expect("tick").is_empty());
    assert!(common::fake_gh_calls().is_empty());
}

#[tokio::test]
async fn the_board_goes_round_one_pull_request_three_times_a_day_at_most() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    let session = database::session();
    github::watch_new(&session).await.expect("watch");
    let change = json!({"kind": "review_comments", "ticket_id": f.tid, "count": 1});
    // some comments wait for the Dev
    let mut row = watched(&f.tid).await;
    row.pending_comments = json!([{"id": "c", "author": "bob", "body": "x"}]).to_string();
    row.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    let run = a_run_row(&f.pid, &f.member, &f.tid, "review_comments").await;
    let seam = Seam::new(json!({"run_id": run.id}));
    // the Dev went round this pull request three times today (two runs of the board and `run`): the signal waits
    a_run_row(&f.pid, &f.member, &f.tid, "ci_red").await;
    a_run_row(&f.pid, &f.member, &f.tid, "ci_red").await;
    github::act(&f.pid, std::slice::from_ref(&change)).await.expect("act");
    assert_eq!(seam.0.calls.lock().expect("lock").len(), 0);
    // fewer than three: it goes
    let (pid2, _) = (f.pid.clone(), 0);
    let f2 = {
        let t = common::ticket(&pid2, "Other", "review").await;
        let mut wt = ai_worktree::new();
        wt.ticket_id = Set(t.id.clone());
        wt.project_id = Set(pid2.clone());
        wt.repo = Set(f.repo.clone());
        wt.path = Set("/x".into());
        wt.branch = Set("b".into());
        wt.pr_number = Set(Some(9));
        wt.insert(&session).await.expect("worktree");
        session.commit().await.expect("commit");
        common::run(&pid2, &f.member, Some(&t.id), "finished", |r| r.mode = Set("work".into())).await;
        t.id
    };
    github::watch_new(&session).await.expect("watch");
    let mut row = watched(&f2).await;
    row.pending_comments = json!([{"id": "c", "author": "bob", "body": "x"}]).to_string();
    row.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    github::act(&f.pid, &[json!({"kind": "review_comments", "ticket_id": f2, "count": 1})]).await.expect("act");
    assert_eq!(seam.0.calls.lock().expect("lock").len(), 1);
    // with `github.auto` off nothing goes by itself
    common::set_ops(&f.pid, json!({"github": {"auto": false}})).await;
    github::act(&f.pid, &[json!({"kind": "review_comments", "ticket_id": f2, "count": 1})]).await.expect("act");
    assert_eq!(seam.0.calls.lock().expect("lock").len(), 1);
}

#[tokio::test]
async fn without_a_dev_or_a_runs_module_nothing_is_delivered() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    let session = database::session();
    github::watch_new(&session).await.expect("watch");
    let mut row = watched(&f.tid).await;
    row.pending_comments = json!([{"id": "c", "author": "bob", "body": "x"}]).to_string();
    row.red = Some(json!({"check": "build", "blamed": true, "url": "u", "base": "main"}).to_string());
    row.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    // the seam is empty: `deliver_to_ticket` reaches no run, so nothing is marked as given
    seams::set_runs(None);
    assert_eq!(github::comments_to_dev(&f.tid).await.expect("to dev"), None);
    common::fake_gh_set("run_view", "log", "", 0);
    assert_eq!(github::back_to_dev(&json!({"ticket_id": f.tid})).await.expect("back"), None);
    let after = watched(&f.tid).await;
    assert!(!after.pending_comments.contains("handled_at"));
    assert!(!after.red.as_deref().unwrap_or("").contains("handled_at"));
    // a ticket nobody worked on has no Dev
    let other = common::ticket(&f.pid, "Nobody worked on this", "review").await;
    let mut row = ai_watched_pr::new();
    row.ticket_id = Set(other.id.clone());
    row.project_id = Set(f.pid.clone());
    row.number = Set(11);
    row.branch = Set("b".into());
    row.repo = Set(f.repo.clone());
    row.pending_comments = Set(json!([{"id": "c", "author": "bob", "body": "x"}]).to_string());
    row.insert(&session).await.expect("row");
    session.commit().await.expect("commit");
    let seam = Seam::new(json!({"run_id": "nope"}));
    assert_eq!(github::comments_to_dev(&other.id).await.expect("to dev"), None);
    assert!(seam.0.calls.lock().expect("lock").is_empty());
    // a seam that answers with a run that does not exist delivers nothing either
    assert_eq!(github::comments_to_dev(&f.tid).await.expect("to dev"), None);
}

#[tokio::test]
async fn the_poll_loop_starts_once_polls_the_pull_requests_and_stops() {
    let _g = common::init().await;
    let f = fixture(json!({})).await;
    common::fake_gh_set("pr_view", &json!({"state": "OPEN", "statusCheckRollup": [{"conclusion": "SUCCESS"}]}).to_string(), "", 0);
    github::start_every(Duration::from_millis(100));
    // a second start while it runs does not start another
    github::start_every(Duration::from_millis(100));
    let tid = f.tid.clone();
    common::until(10, || async {
        let session = database::session();
        ai_watched_pr::Entity::find_by_id(tid.as_str()).one(&session).await.expect("read").is_some_and(|r| r.ci.as_deref() == Some("green"))
    })
    .await;
    github::stop().await;
    let after = common::fake_gh_calls().len();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(common::fake_gh_calls().len(), after, "the loop is gone");
    // stopping again does nothing
    github::stop().await;
}
