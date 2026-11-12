//! `kb_ideas::register()` and what the ticket code does through it (`services/tickets.py` lines 735-765 and the
//! reopen functions): an idea follows its ticket's status (Done ships it, Won't do sends it back to Exploring,
//! reopening restores it), a closed test ticket asks what it showed, and a deleted ticket sends its idea back to
//! Ready. The REST tests need the app to register the hook; this one does it itself, in one process with its own
//! database, so the hook is checked whether or not the app registers it yet.

use kb_board::projects::create_project;
use kb_board::schemas::ProjectCreate;
use kb_board::tickets::{ReopenOptions, TicketUpdate, delete_ticket, get_ticket, reopen_ticket, update_ticket};
use kb_db::database;
use kb_ideas::idea_promote::{Promote, promote};
use kb_ideas::idea_space::{create_test_ticket, get_or_raise};
use kb_ideas::idea_tickets::{NewIdea, add_assumption, create_idea_ticket};
use serde_json::Value;

#[tokio::test]
#[allow(unsafe_code)]
async fn the_idea_follows_its_ticket_through_the_registered_hook() {
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
    kb_base::ctx::scope(scenario()).await;
}

fn labels(trail: &str) -> Vec<String> {
    let entries: Vec<Value> = serde_json::from_str(trail).expect("trail");
    entries.iter().map(|e| e["label"].as_str().expect("label").to_string()).collect()
}

async fn promoted(project_id: &str, title: &str) -> (String, String) {
    let session = database::session();
    let idea = create_idea_ticket(&session, Some(project_id), NewIdea::new(title)).await.expect("idea");
    let args = Promote { acknowledge_not_ready: true, ..Default::default() };
    let (_, ticket, _) = promote(&session, &idea.id, &args).await.expect("promoted");
    (idea.id.clone(), ticket.id)
}

async fn scenario() {
    let project = {
        let session = database::session();
        let data = ProjectCreate { name: "Ideas".into(), prefix: "IDH".into(), color: "#123456".into() };
        create_project(&session, &data).await.expect("project")
    };
    let pid = project.id.as_str();

    // before the hook is registered the ticket code leaves the idea alone
    let (idea_id, ticket_id) = promoted(pid, "Before the hook").await;
    {
        let session = database::session();
        update_ticket(&session, &ticket_id, &TicketUpdate::status("done")).await.expect("moved").expect("found");
        assert_eq!(get_or_raise(&session, &idea_id).await.expect("idea").stage, "building");
    }

    kb_ideas::register();

    // Done ships the idea, with a system entry; reopening the ticket restores it
    let (idea_id, ticket_id) = promoted(pid, "Ships").await;
    let session = database::session();
    update_ticket(&session, &ticket_id, &TicketUpdate::status("in-progress")).await.expect("moved").expect("found");
    assert_eq!(get_or_raise(&session, &idea_id).await.expect("idea").stage, "building");
    update_ticket(&session, &ticket_id, &TicketUpdate::status("done")).await.expect("moved").expect("found");
    let idea = get_or_raise(&session, &idea_id).await.expect("idea");
    assert_eq!((idea.stage.as_str(), idea.idea_status.as_str()), ("shipped", "approved"));
    assert!(idea.shipped_at.is_some() && idea.shipped_at == idea.stage_changed_at);
    assert!(labels(&idea.activity_trail).last().expect("entry").ends_with(" is Done: shipped"));
    let reopened = reopen_ticket(&session, &ticket_id, ReopenOptions::default()).await;
    let reopened = reopened.expect("reopened").expect("found");
    assert_eq!(reopened.status, "todo");
    let idea = get_or_raise(&session, &idea_id).await.expect("idea");
    assert_eq!((idea.stage.as_str(), idea.shipped_at.clone()), ("building", None));
    assert!(labels(&idea.activity_trail).last().expect("entry").ends_with(" was reopened: building again"));

    // Won't do sends the idea back to Exploring with the ticket remembered, and it can be promoted again
    let (idea_id, ticket_id) = promoted(pid, "Dropped").await;
    let update = TicketUpdate::of("status", Value::String("wont_do".into()));
    let mut fields = update.fields.clone();
    fields.insert("wont_do_reason".into(), Value::String("no".into()));
    update_ticket(&session, &ticket_id, &TicketUpdate { fields }).await.expect("moved").expect("found");
    let idea = get_or_raise(&session, &idea_id).await.expect("idea");
    assert_eq!((idea.stage.as_str(), idea.idea_status.as_str()), ("exploring", "in_review"));
    assert_eq!(
        (idea.former_ticket_id.as_deref(), idea.promoted_to_ticket_id.clone()),
        (Some(ticket_id.as_str()), None)
    );
    let args = Promote { acknowledge_not_ready: true, ..Default::default() };
    promote(&session, &idea_id, &args).await.expect("promoted again");

    // a deleted ticket sends its idea back to Ready, and an assumption it tested loses the link
    let (idea_id, ticket_id) = promoted(pid, "Deleted").await;
    assert!(delete_ticket(&session, &ticket_id).await.expect("deleted"));
    let idea = get_or_raise(&session, &idea_id).await.expect("idea");
    assert_eq!((idea.stage.as_str(), idea.former_ticket_id.as_deref()), ("ready", Some(ticket_id.as_str())));
    assert!(
        labels(&idea.activity_trail)
            .last()
            .expect("entry")
            .ends_with(" was deleted: back to Ready. Promote again if you want.")
    );

    // a test ticket: closing it asks what it showed; deleting it frees the assumption (Testing goes back to Untested)
    let idea = create_idea_ticket(&session, Some(pid), NewIdea::new("Tested")).await.expect("idea");
    let idea = add_assumption(&session, &idea.id, "They pay", "high", Some("user"), false).await.expect("assumption");
    let a_id = idea.assumption_records[0].row.id.clone();
    let (idea, test_ticket) =
        create_test_ticket(&session, &idea.id, &a_id, None, None, Some("user")).await.expect("test ticket");
    assert_eq!(idea.assumption_records[0].row.status, "testing");
    assert_eq!(test_ticket.tests_assumption_id.as_deref(), Some(a_id.as_str()));
    update_ticket(&session, &test_ticket.id, &TicketUpdate::status("done")).await.expect("moved").expect("found");
    let idea = get_or_raise(&session, &idea.id).await.expect("idea");
    let entries: Vec<Value> = serde_json::from_str(&idea.activity_trail).expect("trail");
    let asked = entries.iter().find(|e| e["meta"]["asks"] == true).expect("an entry that asks");
    assert_eq!(asked["author"], "system");
    assert_eq!(asked["meta"]["ticket"], test_ticket.id.as_str());
    assert!(delete_ticket(&session, &test_ticket.id).await.expect("deleted"));
    let idea = get_or_raise(&session, &idea.id).await.expect("idea");
    assert_eq!(
        (idea.assumption_records[0].row.test_ticket_id.clone(), idea.assumption_records[0].row.status.as_str()),
        (None, "untested")
    );
    assert!(get_ticket(&session, &test_ticket.id).await.expect("read").is_none());
}
