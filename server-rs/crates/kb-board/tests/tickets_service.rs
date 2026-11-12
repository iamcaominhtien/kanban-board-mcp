//! The parts of `services/tickets.py` (lines 1-800) that no REST route reaches, in one process with its own
//! database: a ticket created with acceptance criteria and a creator (what the MCP tools pass), the project that
//! does not exist, and the calls into the AI team and the Idea Space (the hooks of `kb_board::hooks`), which the
//! Python code imports late.

use std::sync::Mutex;

use async_trait::async_trait;
use kb_base::ApiResult;
use kb_board::hooks::{self, AiRunsHook, IdeaPromoteHook, NewAssignee};
use kb_board::projects::create_project;
use kb_board::schemas::ProjectCreate;
use kb_board::tickets::{Error, NewTicket, TicketUpdate, create_ticket, delete_ticket, get_ticket, update_ticket};
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
}
