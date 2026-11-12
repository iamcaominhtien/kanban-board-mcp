//! `tests/test_docs_268.py`: the test of that file that goes through the routes of this half
//! (`test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page`). It needs an AI team (`POST /projects/{pid}/ai/teams`,
//! the AI area): it runs where the server serves that route (Python now, Rust when `kb-ai` is ported). The other tests of
//! the file are the pure edits (`kb-doctext`) and MCP tools (they wait for the MCP port).

mod common;

use common::{id, mk, pid};
use serde_json::json;
use testkit::{Server, skip_unless_available};

#[tokio::test]
async fn test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page() {
    if !skip_unless_available("test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let repo = common::repo_dir("main", "t");
    let fake = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../server/tests/fixtures/fake_claude.py");
    let body = json!({"name": "Writer", "working_dir": repo.path(), "cli_path": fake, "model": "haiku"});
    let r = c.post(&format!("/projects/{pid}/ai/teams"), body).await;
    if r.status == 404 || r.status == 405 {
        eprintln!("SKIPPED: this server does not serve the AI teams yet");
        return;
    }
    assert_eq!(r.status, 201, "{}", r.text());
    let member = r.json();
    let page = mk(&c, &pid, "Export spec", json!({"markdown": "## Goal\n\nCSV export.\n"})).await;
    let r = c
        .post(
            &format!("/docs/pages/{}/assign", id(&page)),
            json!({"member_id": member["id"], "kind": "write", "instruction": "Add the columns"}),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.text());
    let key = r.json()["ticket"]["id"].as_str().expect("ticket id").to_string();
    let work = c.get(&format!("/docs/pages/{}/work", id(&page))).await.json();
    assert_eq!(work["tickets"][0]["id"], json!(key));
    assert_eq!(work["tickets"][0]["run"]["member"], "Writer");
    let bad = c.post(&format!("/docs/pages/{}/assign", id(&page)), json!({"member_id": "nope", "kind": "write"})).await;
    assert_eq!(bad.status, 422);
}
