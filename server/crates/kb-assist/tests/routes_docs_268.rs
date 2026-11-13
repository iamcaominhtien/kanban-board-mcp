//! The Docs AI's route part of `server/tests/test_docs_268.py`, through HTTP: a person gives a page to an AI team
//! (`POST /docs/pages/{id}/assign`, `docs_work.assign_page`, whose ticket assignment wakes the team's lead through
//! `kb_docs::hooks::AssignHook` and the runs).
//!
//! The other tests of that file call the MCP tools `docs_read` / `docs_write` (and are the MCP port's), or are pure
//! functions of `docs_edit` and `docs_guide`; `test_give_a_page_to_an_ai_member` is the MCP form of this one and also
//! waits with the tools.

mod http;

use http::start;
use serde_json::json;

#[tokio::test]
async fn test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page() {
    let Some(f) = start("test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page", &[]).await else { return };
    let c = &f.c;
    let (pid, _) = f.project().await;
    let member = f.runner(&pid, "Writer", json!({})).await;
    let page = c
        .post(
            &format!("/projects/{pid}/docs/pages"),
            json!({"title": "Export spec", "markdown": "## Goal\n\nCSV export.\n"}),
        )
        .await;
    page.assert_status(201);
    let page_id = http::id(&page.json());
    let r = c
        .post(
            &format!("/docs/pages/{page_id}/assign"),
            json!({"member_id": member["id"], "kind": "write", "instruction": "Add the columns"}),
        )
        .await;
    r.assert_status(201);
    let key = r.json()["ticket"]["id"].as_str().expect("ticket").to_string();
    let work = c.get(&format!("/docs/pages/{page_id}/work")).await.json();
    assert_eq!(work["tickets"][0]["id"], key.as_str());
    assert_eq!(work["tickets"][0]["run"]["member"], "Writer", "{work}");
    let bad = c.post(&format!("/docs/pages/{page_id}/assign"), json!({"member_id": "nope", "kind": "write"})).await;
    bad.assert_status(422);
}
