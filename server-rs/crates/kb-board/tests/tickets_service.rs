//! The parts of `services/tickets.py` that no REST route reaches, in one process with its own
//! database: a ticket created with acceptance criteria and a creator (what the MCP tools pass), the project that
//! does not exist, and the calls into the AI team and the Idea Space (the hooks of `kb_board::hooks`), which the
//! Python code imports late.

use std::sync::Mutex;

use async_trait::async_trait;
use kb_base::ApiResult;
use kb_board::hooks::{self, AiRunsHook, IdeaPromoteHook, NewAssignee};
use kb_board::projects::create_project;
use kb_board::schemas::ProjectCreate;
use kb_board::tickets::{
    Error, NewBranch, NewTestCase, NewTicket, NewWorkLog, PendingReason, ReopenOptions, TestCaseChanges, TicketUpdate,
    add_branch, add_comment, add_test_case, add_ticket_link, add_work_log, clear_pending, create_ticket, delete_ticket,
    get_project_activities, get_ticket, list_branches, reopen_ticket, set_pending, undo_reopen, update_test_case,
    update_ticket,
};
use kb_db::entities::{story, ticket};
use kb_db::sea_orm::{DbErr, EntityTrait};
use kb_db::{Session, database};
use serde_json::{Value, json};

static CALLS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn calls() -> Vec<String> {
    std::mem::take(&mut *CALLS.lock().expect("calls"))
}

fn call(text: String) {
    CALLS.lock().expect("calls").push(text);
}

struct Ideas;

#[async_trait]
impl IdeaPromoteHook for Ideas {
    async fn on_ticket_status_change(
        &self,
        session: &Session,
        ticket: &ticket::Model,
        previous_status: &str,
    ) -> Result<(), DbErr> {
        // called before the commit, with the ticket as the session now holds it
        let stored = ticket::Entity::find_by_id(ticket.id.as_str()).one(session).await?.expect("ticket");
        let committed = ticket::Entity::find_by_id(ticket.id.as_str()).one(&database::session()).await?;
        call(format!(
            "status_change {} {previous_status}->{} stored={} committed={}",
            ticket.id,
            ticket.status,
            stored.status,
            committed.expect("ticket").status
        ));
        Ok(())
    }

    async fn on_ticket_deleted(&self, _session: &Session, ticket: &ticket::Model) -> Result<(), DbErr> {
        call(format!("deleted {}", ticket.id));
        Ok(())
    }
}

struct Runs;

#[async_trait]
impl AiRunsHook for Runs {
    async fn before_ticket_change(
        &self,
        _ticket_id: &str,
        _status: Option<&str>,
        _assignee: NewAssignee<'_>,
        _deleting: bool,
        _by: &str,
    ) -> ApiResult<()> {
        Ok(())
    }

    async fn note_person_edit(&self, _ticket_id: &str, _by: &str, _what: &str, _tell_lead: bool) -> ApiResult<()> {
        Ok(())
    }

    async fn wake_new_assignee(&self, _ticket_id: &str, _assignee_id: &str, _by: &str) -> ApiResult<()> {
        Ok(())
    }

    fn in_run(&self) -> bool {
        false
    }

    fn on_status(&self, ticket_id: &str, status: &str, previous: &str, by_ai: bool) {
        call(format!("on_status {ticket_id} {previous}->{status} by_ai={by_ai}"));
    }
}

fn message(result: Result<ticket::Model, Error>) -> String {
    match result {
        Err(Error::Value(message)) => message,
        other => panic!("expected a ValueError, got {other:?}"),
    }
}

async fn counter(project_id: &str) -> i32 {
    let session = database::session();
    kb_db::entities::project::Entity::find_by_id(project_id)
        .one(&session)
        .await
        .expect("query")
        .expect("project")
        .ticket_counter
}

#[tokio::test]
#[allow(unsafe_code)]
async fn the_service_functions_behind_the_tools_and_the_hooks() {
    let dir = tempfile::tempdir().expect("temporary folder");
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("workspace"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("database setup");
    database::init_db().await.expect("schema");
    kb_base::ctx::scope(scenario(dir.path())).await;
}

async fn scenario(root: &std::path::Path) {
    let project = {
        let session = database::session();
        let data = ProjectCreate { name: "Board".into(), prefix: "SVC".into(), color: "#123456".into() };
        create_project(&session, &data).await.expect("project")
    };
    let pid = project.id.as_str();

    // while no hook is registered, a move and a delete call nothing and work
    {
        let session = database::session();
        let t = create_ticket(&session, pid, NewTicket::new("No hooks yet")).await.expect("ticket");
        let session = database::session();
        let moved = update_ticket(&session, &t.id, &TicketUpdate::status("done")).await.expect("moved").expect("found");
        assert_eq!(moved.status, "done");
        assert!(delete_ticket(&database::session(), &t.id).await.expect("deleted"));
    }
    hooks::set_idea_promote_hook(Box::new(Ideas));
    hooks::set_ai_runs_hook(Box::new(Runs));

    // acceptance criteria and the creator are written with the ticket
    let criteria = vec!["  A wrong password shows a message  ".to_string(), "The email is kept".to_string()];
    let session = database::session();
    let new = NewTicket {
        created_by: Some("someone"),
        acceptance_criteria: Some(&criteria),
        r#type: "bug",
        ..NewTicket::new("  Login  ")
    };
    let t = create_ticket(&session, pid, new).await.expect("ticket");
    assert_eq!((t.id.as_str(), t.title.as_str(), t.created_by.as_deref()), ("SVC-2", "Login", Some("someone")));
    let stored: Vec<Value> = serde_json::from_str(&t.acceptance_criteria).expect("criteria");
    let texts: Vec<(&str, &Value)> = stored.iter().map(|c| (c["text"].as_str().expect("text"), &c["done"])).collect();
    assert_eq!(texts, [("A wrong password shows a message", &json!(false)), ("The email is kept", &json!(false))]);
    assert!(stored.iter().all(|c| c["id"].as_str().is_some_and(|id| id.len() == 36)));
    // `{"id": ..., "text": ..., "done": false}`, as `json.dumps` writes it
    assert!(t.acceptance_criteria.starts_with(r#"[{"id": ""#), "{}", t.acceptance_criteria);
    assert!(t.acceptance_criteria.ends_with(r#"", "text": "The email is kept", "done": false}]"#));
    let log: Vec<Value> = serde_json::from_str(&t.activity_log).expect("log");
    let shown: Vec<(&str, &Value, &Value)> =
        log.iter().map(|e| (e["field"].as_str().expect("field"), &e["to"], &e["ref"])).collect();
    assert_eq!(
        shown,
        [
            ("created", &Value::Null, &json!("Login")),
            ("acceptance_criterion", &json!("A wrong password shows a message"), &Value::Null),
            ("acceptance_criterion", &json!("The email is kept"), &Value::Null),
        ]
    );
    assert!(log.iter().all(|e| e["actor"] == "user"));
    // without a creator, the project's first member is the creator
    let first = create_ticket(&database::session(), pid, NewTicket::new("Second")).await.expect("ticket");
    assert!(first.created_by.is_some_and(|by| by != "someone" && by.len() == 36));

    // refused before anything is written: the number is not used
    assert_eq!(counter(pid).await, 3);
    let too_many: Vec<String> = (0..51).map(|n| format!("criterion {n}")).collect();
    let new = NewTicket { acceptance_criteria: Some(&too_many), ..NewTicket::new("Too many") };
    assert_eq!(
        message(create_ticket(&database::session(), pid, new).await),
        "At most 50 acceptance criteria at once: split the ticket, or add the rest one by one."
    );
    let blank = vec!["ok".to_string(), "   ".to_string()];
    let new = NewTicket { acceptance_criteria: Some(&blank), ..NewTicket::new("Blank") };
    assert_eq!(message(create_ticket(&database::session(), pid, new).await), "Acceptance criterion must not be empty");
    let long = vec!["x".repeat(1001)];
    let new = NewTicket { acceptance_criteria: Some(&long), ..NewTicket::new("Long") };
    assert_eq!(
        message(create_ticket(&database::session(), pid, new).await),
        "Acceptance criterion must be at most 1000 characters"
    );
    // a Story under a parent is refused after the number was taken: the session is dropped, the number comes back
    let new = NewTicket { r#type: "story", parent_id: Some("SVC-2"), ..NewTicket::new("Story child") };
    assert_eq!(
        message(create_ticket(&database::session(), pid, new).await),
        "A Story holds tickets, never Stories: it cannot have a parent."
    );
    assert_eq!(counter(pid).await, 3);
    match create_ticket(&database::session(), "no-such-project", NewTicket::new("Nowhere")).await {
        Err(Error::NoResult(message)) => assert_eq!(message, "Project no-such-project not found"),
        other => panic!("{other:?}"),
    }
    // a Story gets its Story row, a Draft made by the ticket's creator
    let new = NewTicket { r#type: "story", ..NewTicket::new("A goal") };
    let goal = create_ticket(&database::session(), pid, new).await.expect("story");
    let row = story::Entity::find_by_id(goal.id.as_str()).one(&database::session()).await.expect("query");
    let row = row.expect("story row");
    assert_eq!((row.state.as_str(), row.project_id.as_str(), &row.created_by), ("draft", pid, &goal.created_by));

    // a move tells the Idea Space before the commit and hands the code over after it
    assert!(calls().is_empty());
    let moved = update_ticket(&database::session(), "SVC-2", &TicketUpdate::status("review")).await;
    assert_eq!(moved.expect("moved").expect("found").status, "review");
    assert_eq!(
        calls(),
        [
            "status_change SVC-2 backlog->review stored=review committed=backlog",
            "on_status SVC-2 backlog->review by_ai=false"
        ]
    );
    // the same status again: the Idea Space is still told (it compares), the code is not handed over
    update_ticket(&database::session(), "SVC-2", &TicketUpdate::status("review")).await.expect("same").expect("found");
    assert_eq!(calls(), ["status_change SVC-2 review->review stored=review committed=review"]);
    // a change that is not a move tells no one; a refused one neither
    update_ticket(&database::session(), "SVC-2", &TicketUpdate::of("title", json!("Renamed"))).await.expect("renamed");
    let refused = update_ticket(&database::session(), "SVC-2", &TicketUpdate::status("wont_do")).await;
    assert!(matches!(refused, Err(Error::Value(m)) if m == "wont_do_reason is required when status is wont_do"));
    assert!(calls().is_empty());
    assert_eq!(
        update_ticket(&database::session(), "SVC-404", &TicketUpdate::status("done")).await.expect("none"),
        None
    );

    // a delete tells the Idea Space and removes the ticket's workspace folder
    let folder = root.join("workspace").join("SVC-2");
    std::fs::create_dir_all(&folder).expect("mkdir");
    std::fs::write(folder.join("report.txt"), "x").expect("write");
    assert!(delete_ticket(&database::session(), "SVC-2").await.expect("deleted"));
    assert_eq!(calls(), ["deleted SVC-2"]);
    assert!(!folder.exists());
    assert_eq!(get_ticket(&database::session(), "SVC-2").await.expect("query"), None);
    assert!(!delete_ticket(&database::session(), "SVC-2").await.expect("gone"));
    assert!(calls().is_empty());

    sub_entities(root, pid).await;
}

/// The second half of `services/tickets.py` (lines 800-2862), what no REST route passes: a comment's extra keys
/// (`meta`, an AI member's reply), a test case a Board AI suggested, a branch of the repository that is adopted, the
/// Python defaults of the argument structs, and the Idea Space told of a reopen and of its undo.
async fn sub_entities(root: &std::path::Path, pid: &str) {
    let session = database::session;
    let held = create_ticket(&session(), pid, NewTicket::new("Holds things")).await.expect("ticket");
    let open = create_ticket(&session(), pid, NewTicket::new("Stays open")).await.expect("ticket");
    let (id, open) = (held.id.as_str(), open.id.as_str());
    // a comment with extra keys: stored after the comment's own, a key of its own name replaces the value in place
    let meta = json!({"ai": {"member_id": "m1"}, "author": "Robo", "reply_to": "c0"});
    let t =
        add_comment(&session(), id, " An answer ", "user", meta.as_object()).await.expect("comment").expect("found");
    let comments: Value = serde_json::from_str(&t.comments).expect("json");
    let keys: Vec<&String> = comments[0].as_object().expect("comment").keys().collect();
    assert_eq!(
        keys,
        ["id", "text", "author", "at", "edited_at", "deleted_at", "mentions", "notified", "ai", "reply_to"]
    );
    assert_eq!((&comments[0]["text"], &comments[0]["author"]), (&json!("An answer"), &json!("Robo")));
    assert_eq!(add_comment(&session(), "SVC-404", "x", "user", None).await.expect("none"), None);

    // a test case a Board AI suggested, with the defaults of `add_test_case`
    let new = NewTestCase { suggested_by: Some("Board AI"), ..NewTestCase::new("Suggested") };
    let t = add_test_case(&session(), id, new).await.expect("test case").expect("found");
    let cases: Value = serde_json::from_str(&t.test_cases).expect("json");
    assert_eq!(cases[0]["suggested_by"], "Board AI");
    assert_eq!(
        (&cases[0]["status"], &cases[0]["code"], &cases[0]["test_data_files"]),
        (&json!("pending"), &json!("TC-1"), &json!([]))
    );
    // a status the routes refuse is what the tools may pass: stored as given
    let changes = TestCaseChanges { status: Some("blocked"), ..TestCaseChanges::default() };
    let tc = cases[0]["id"].as_str().expect("id").to_string();
    let t = update_test_case(&session(), id, &tc, changes).await.expect("update").expect("found");
    assert!(t.test_cases.contains(r#""status": "blocked""#));

    // the work log: a kind and a role the routes refuse before the service does
    let refused = add_work_log(&session(), id, NewWorkLog::new("a", "Wizard", "n")).await;
    assert_eq!(
        message(refused.map(|t| t.expect("found"))),
        "Invalid role 'Wizard'. Valid roles: ['PM', 'Developer', 'BA', 'Tester', 'Designer', 'Other']"
    );
    let new = NewWorkLog { kind: "weird", ..NewWorkLog::new("a", "PM", "n") };
    assert_eq!(
        message(add_work_log(&session(), id, new).await.map(|t| t.expect("found"))),
        "Invalid kind 'weird'. Valid kinds: ['investigation', 'fix_attempt', 'root_cause', 'blocked', 'resolved']"
    );
    let new = NewWorkLog { attachments: Some(&[json!("x")]), ..NewWorkLog::new("a", "PM", "n") };
    assert_eq!(
        message(add_work_log(&session(), id, new).await.map(|t| t.expect("found"))),
        "Each attachment must be an object"
    );

    // a status and a relation the routes refuse before the service does
    let new = NewBranch { status: "closed", ..NewBranch::new("x") };
    assert_eq!(
        message(add_branch(&session(), id, new).await.map(|t| t.expect("found"))),
        "Invalid branch status 'closed'. Valid statuses: ['archived', 'baseline', 'merged', 'open', 'stale']"
    );
    match add_ticket_link(&session(), id, open, "blocks").await {
        Err(Error::Value(m)) => assert_eq!(
            m,
            "Invalid relation type 'blocks'. Valid types: ['caused_by', 'causes', 'duplicated_by', 'duplicates', 'relates_to']"
        ),
        other => panic!("{other:?}"),
    }
    let refused = set_pending(&session(), id, PendingReason::new("weather")).await;
    assert_eq!(message(refused.map(|t| t.expect("found"))), "Invalid reason_type 'weather'");

    // a branch that is already in the repository: refused, or recorded as it is when adopted
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("mkdir");
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").args(args).current_dir(&repo).output().expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "T"]);
    std::fs::write(repo.join("a.txt"), "a").expect("write");
    git(&["add", "."]);
    git(&["commit", "-qm", "init"]);
    git(&["checkout", "-q", "-b", "agent/work"]);
    std::fs::write(repo.join("b.txt"), "b").expect("write");
    git(&["add", "."]);
    git(&["commit", "-qm", "work"]);
    git(&["checkout", "-q", "main"]);
    let repo_path = TicketUpdate::of("repo_path", json!(repo.to_string_lossy()));
    update_ticket(&session(), id, &repo_path).await.expect("repo").expect("found");
    let refused = add_branch(&session(), id, NewBranch::new("agent/work")).await;
    assert_eq!(message(refused.map(|t| t.expect("found"))), "Branch 'agent/work' already exists");
    let new = NewBranch { adopt: true, ..NewBranch::new("agent/work") };
    let t = add_branch(&session(), id, new).await.expect("adopted").expect("found");
    let branches: Value = serde_json::from_str(&t.branches).expect("json");
    assert_eq!(
        (&branches[0]["name"], &branches[0]["ahead_count"], &branches[0]["branch_from"]),
        (&json!("agent/work"), &json!(1), &json!("main"))
    );
    // adopting a branch that is not there creates it
    let new = NewBranch { adopt: true, ..NewBranch::new("agent/new") };
    add_branch(&session(), id, new).await.expect("created").expect("found");
    let listed = list_branches(&session(), id).await.expect("list").expect("found");
    assert_eq!(listed.iter().map(|b| b["in_repo"].clone()).collect::<Vec<_>>(), [json!(true), json!(true)]);

    // a reopen and its undo tell the Idea Space, before the commit, with the ticket as it then is
    calls();
    update_ticket(&session(), id, &TicketUpdate::status("done")).await.expect("done").expect("found");
    calls();
    reopen_ticket(&session(), id, ReopenOptions::default()).await.expect("reopened").expect("found");
    assert_eq!(calls(), [format!("status_change {id} done->todo stored=todo committed=done")]);
    undo_reopen(&session(), id).await.expect("undone").expect("found");
    assert_eq!(calls(), [format!("status_change {id} todo->done stored=done committed=todo")]);
    // a reopen that is refused tells no one, and leaves nothing behind
    let refused = reopen_ticket(&session(), open, ReopenOptions::default()).await;
    assert_eq!(message(refused.map(|t| t.expect("found"))), "Only tickets in Done or Won't Do can be reopened");
    assert!(calls().is_empty());
    assert_eq!(
        clear_pending(&session(), id, None, false, None).await.expect("not pending").expect("found").status,
        "done"
    );
    let events = get_project_activities(&session(), pid, 2).await;
    assert_eq!(events.expect("events").len(), 2);
}
