//! The Docs AI's part of `server/tests/test_docs_268.py`: giving a page to an AI team (`docs_work.assign_page`), which
//! calls `create_ticket`, `update_ticket` and `ai_runs.wake_new_assignee`. The first two are `kb_board::tickets`
//! calls and the third goes through `seams::Runs`; `kb_docs::hooks::AssignHook` is what this crate registers for
//! them (`kb_assist::register`).
//!
//! The Python tests call the MCP tool `docs_write(action="assign")` and `POST /docs/pages/{id}/assign`; here the
//! service `docs_work.assign_page` is called, which is what both end in. The 422 of the route for a member that is not
//! there is `Error::Value`; the tool's own `kind` check waits with the tool.

mod common;

use std::sync::Arc;

use async_trait::async_trait;
use kb_db::database;
use kb_db::entities::ai_run;
use kb_db::sea_orm::ActiveValue::Set;
use kb_docs::Error;
use kb_docs::docs_work;
use serde_json::{Map, Value, json};

/// A `seams::Runs` whose `wake_new_assignee` starts a run (the one of the Python test starts the team's lead).
struct Waking;

#[async_trait]
impl kb_assist::seams::Runs for Waking {
    fn url(&self) -> String {
        common::BOARD_URL.to_string()
    }

    fn to_dict(&self, run: &ai_run::Model) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("id".into(), json!(run.id));
        out
    }

    async fn deliver_to_ticket(
        &self,
        _ticket_id: &str,
        _text: &str,
        _by: &str,
    ) -> Result<Value, kb_assist::seams::DeliverError> {
        Ok(json!({}))
    }

    async fn wake_new_assignee(
        &self,
        _ticket_id: &str,
        _member_id: &str,
        _by: Option<&str>,
        _instruction: &str,
    ) -> Option<(String, String)> {
        Some(("run-woken".to_string(), "queued".to_string()))
    }
}

async fn page_in(pid: &str, title: &str, markdown: &str) -> String {
    let s = database::session();
    let page = kb_docs::docs::create_page(&s, pid, title, None, "blank", Some(markdown)).await.expect("page");
    page["id"].as_str().expect("id").to_string()
}

#[tokio::test]
async fn test_give_a_page_to_an_ai_member() {
    let _guard = common::init().await;
    kb_assist::register();
    kb_assist::seams::set_runs(Some(Arc::new(Waking)));
    let (pid, _an) = common::project().await;
    let member = common::team_of(&pid, "BA", json!({})).await;
    let member_id = member["id"].as_str().expect("id").to_string();
    let page = page_in(&pid, "Login spec", "## Goal\n\nSign in with email.\n").await;
    let s = database::session();
    let out = docs_work::assign_page(&s, &page, &member_id, "review", Some("Check the error cases"), None)
        .await
        .expect("assign");
    let key = out["ticket"]["id"].as_str().expect("key").to_string();
    assert_eq!(out["ticket"]["title"], "Review the page “Login spec”");
    // assigning the team started its lead
    assert!(out["run"]["id"].as_str().is_some_and(|id| !id.is_empty()));
    let ticket = kb_board::tickets::get_ticket(&s, &key).await.expect("get").expect("the ticket");
    assert_eq!(ticket.assignee.as_deref(), Some(member_id.as_str()));
    assert!(ticket.description.contains("Review [[Login spec]]."));
    assert!(ticket.description.contains("> Check the error cases"));
    // the work on the page shows the run of the team
    common::run(&pid, &member_id, Some(&key), "running", |r| r.number = Set(1)).await;
    let work = docs_work::work_on_page(&s, &page).await.expect("work");
    let row = &work["tickets"][0];
    assert!(row["id"] == key.as_str() && row["run"]["member"] == "BA");
    // a `kind` the page is not given for (the tool: `ValueError` naming `kind`)
    let bad = docs_work::assign_page(&s, &page, &member_id, "", None, None).await.expect_err("a kind is needed");
    assert!(matches!(bad, Error::Value(ref m) if m.contains("kind")), "{bad:?}");
    kb_assist::seams::set_runs(None);
}

#[tokio::test]
async fn test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page() {
    let _guard = common::init().await;
    kb_assist::register();
    kb_assist::seams::set_runs(Some(Arc::new(Waking)));
    let (pid, _an) = common::project().await;
    let member = common::team_of(&pid, "Writer", json!({})).await;
    let member_id = member["id"].as_str().expect("id").to_string();
    let page = page_in(&pid, "Export spec", "## Goal\n\nCSV export.\n").await;
    let s = database::session();
    let out = docs_work::assign_page(&s, &page, &member_id, "write", Some("Add the columns"), Some("An Nguyen"))
        .await
        .expect("assign");
    let key = out["ticket"]["id"].as_str().expect("key").to_string();
    common::run(&pid, &member_id, Some(&key), "running", |r| r.number = Set(1)).await;
    let work = docs_work::work_on_page(&s, &page).await.expect("work");
    assert_eq!(work["tickets"][0]["id"], key.as_str());
    assert_eq!(work["tickets"][0]["run"]["member"], "Writer");
    // `POST /docs/pages/{id}/assign` with a member that is not there answers 422 (a `ValueError`)
    let bad = docs_work::assign_page(&s, &page, "nope", "write", None, None).await.expect_err("no such team");
    assert!(matches!(bad, Error::Value(_)));
    kb_assist::seams::set_runs(None);
}
