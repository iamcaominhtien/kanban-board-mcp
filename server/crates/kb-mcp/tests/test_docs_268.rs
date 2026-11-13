//! `tests/test_docs_268.py`, the tests that go through the Docs tools: every AI works in Docs like a person. Edit a
//! part of a page (with a check that it has not changed), upload a file to a page and a ticket, the tickets a page
//! links, tickets from a page, and the Docs guide.
//!
//! Waiting for the AI port (they need an AI team of the project, its runs and the plugin folder of the skills):
//! `test_give_a_page_to_an_ai_member` (`docs_write(assign)` creates a ticket for the team and starts its lead),
//! `test_a_person_gives_a_page_to_an_ai_and_sees_its_work_on_the_page`, the skill half of
//! `test_the_docs_guide_is_one_text_in_both_places` (`board_skills._skills()`), and
//! `test_every_run_is_told_to_open_the_docs_guide_before_writing_a_page` (the prompt block of a run). The pure
//! tests (`docs_edit`, `docs_anchors`) are unit tests of `kb-doctext`.

mod common;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use common::{call, call_err};
use serde_json::{Value, json};

const PAGE: &str = "## Overview\n\nThe API is REST.\n\n## Endpoints\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n\n### Errors\n\n401 when the token is missing.\n\n## Limits\n\nRate limits are not enforced yet.\n";

const PNG: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0xf8, 0x0f, 0x00, 0x01, 0x04, 0x01, 0x00, 0xc1, 0x2d, 0x8e,
    0x50, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

async fn write(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_write", arguments).await
}

async fn read(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_read", arguments).await
}

async fn fail(mcp: &testkit::Mcp, action: &str, rest: Value) -> String {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call_err(mcp, "docs_write", arguments).await
}

async fn page(mcp: &testkit::Mcp, pid: &Value, title: &str, markdown: &str) -> Value {
    write(mcp, "create", json!({"project_id": pid, "title": title, "markdown": markdown})).await
}

#[tokio::test]
async fn test_edit_one_section_keeps_what_another_person_changed() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, _) = common::rest_ticket(&c, "t", "DOC", json!({})).await;
    let pid = &project["id"];
    let made = page(&mcp, pid, "API", PAGE).await;
    // a person publishes a change to Overview after the agent read v1
    write(
        &mcp,
        "update",
        json!({"page_id": made["id"], "markdown": PAGE.replace("The API is REST.", "The API is REST and MCP."), "base_version": 1}),
    )
    .await;
    let out = write(
        &mcp,
        "edit",
        json!({"page_id": made["id"], "section": "Limits", "markdown": "Rate limits: 100 requests per minute per token.", "base_version": 1}),
    )
    .await;
    assert!(out["version"] == 3 && out["changed"] == json!(["section 'Limits'"]));
    assert!(out["now"].as_str().expect("text").starts_with("## Limits\n\nRate limits: 100"));
    let text = read(&mcp, "get", json!({"page_id": made["id"]})).await["markdown"].as_str().expect("text").to_string();
    assert!(text.contains("REST and MCP") && text.contains("100 requests"));
    assert_eq!(read(&mcp, "versions", json!({"page_id": made["id"]})).await[0]["note"], "Edited section 'Limits'");
    // the same section changed since v1: refused, nothing published
    let refused =
        fail(&mcp, "edit", json!({"page_id": made["id"], "section": "Overview", "markdown": "x", "base_version": 1}))
            .await;
    assert!(
        refused.contains("conflict") && refused.contains("REST and MCP") && refused.contains("Nothing was changed"),
        "{refused}"
    );
    let part = read(&mcp, "get", json!({"page_id": made["id"], "section": "Endpoints"})).await;
    let markdown = part["markdown"].as_str().expect("text");
    assert!(markdown.starts_with("## Endpoints") && markdown.contains("### Errors"));
    assert!(part["version"] == 3 && part.get("referenced_by").is_none());
}

#[tokio::test]
async fn test_edit_a_passage_and_several_edits_in_one_version() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, _) = common::rest_ticket(&c, "t", "DOC", json!({})).await;
    let made = page(&mcp, &project["id"], "API", PAGE).await;
    let out = write(
        &mcp,
        "edit",
        json!({"page_id": made["id"], "find": "not enforced yet", "markdown": "==enforced since v2=="}),
    )
    .await;
    assert_eq!(out["version"], 2);
    let refused = fail(&mcp, "edit", json!({"page_id": made["id"], "find": "not enforced yet", "markdown": "x"})).await;
    assert!(refused.contains("not on the page"), "{refused}");
    let out = write(
        &mcp,
        "edit",
        json!({"page_id": made["id"], "items": [
            {"section": "Overview", "markdown": "REST and MCP."},
            {"find": "| GET | /tickets |", "markdown": "\n| POST | /tickets |", "mode": "after"},
            {"markdown": "## Changelog\n\n- v2", "mode": "append"},
        ]}),
    )
    .await;
    assert!(out["version"] == 3 && out["changed"].as_array().expect("changed").len() == 3);
    let text = read(&mcp, "get", json!({"page_id": made["id"]})).await["markdown"].as_str().expect("text").to_string();
    assert!(text.contains("| GET | /tickets |\n| POST | /tickets |"));
    assert!(text.trim_end().ends_with("## Changelog\n\n- v2"));
    // one bad edit: nothing is published
    let refused = fail(
        &mcp,
        "edit",
        json!({"page_id": made["id"], "items": [{"section": "Overview", "markdown": "y"}, {"find": "nope", "markdown": "z"}]}),
    )
    .await;
    assert!(refused.contains("items[1]"), "{refused}");
    assert_eq!(read(&mcp, "get", json!({"page_id": made["id"]})).await["version"], 3);
    let refused =
        fail(&mcp, "edit", json!({"page_id": made["id"], "section": "Overview", "markdown": "x", "title": "T"})).await;
    assert!(refused.contains("does not use: title"), "{refused}");
}

#[tokio::test]
async fn test_upload_a_picture_to_a_page_and_a_file_to_a_ticket() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, ticket) = common::rest_ticket(&c, "Login", "DOC", json!({})).await;
    let tid = ticket["id"].as_str().expect("a ticket id");
    let made = page(&mcp, &project["id"], "API", PAGE).await;
    // (not `tempfile::tempdir()`: its folder name starts with a dot, which the board never copies from)
    let dir = tempfile::Builder::new().prefix("kbdocs").tempdir().expect("a folder");
    let shot = dir.path().join("login.png");
    std::fs::write(&shot, PNG).expect("a picture");
    let out =
        write(&mcp, "upload", json!({"path": shot.to_string_lossy(), "page_id": made["id"], "section": "Overview"}))
            .await;
    assert!(out["markdown"].as_str().expect("text").starts_with("![login.png](/uploads/login-"));
    assert!(out["type"] == "image/png" && out["page"]["version"] == 2);
    let stored = s.uploads_dir().join(out["url"].as_str().expect("a url").trim_start_matches("/uploads/"));
    assert_eq!(std::fs::read(stored).expect("the copy"), PNG);
    let text = read(&mcp, "get", json!({"page_id": made["id"]})).await["markdown"].as_str().expect("text").to_string();
    assert!(text.contains(&format!("The API is REST.\n\n{}\n\n## Endpoints", out["markdown"].as_str().expect("text"))));
    // bytes from an agent whose files are elsewhere, posted on a ticket
    let log = write(
        &mcp,
        "upload",
        json!({"data": STANDARD.encode(b"boom"), "name": "trace.log", "ticket_id": tid, "body": "The failing request", "author": "Claude"}),
    )
    .await;
    assert!(log["markdown"].as_str().expect("text").starts_with("[trace.log](/uploads/trace-"));
    let ticket = c.get(&format!("/tickets/{tid}")).await.json();
    let last = ticket["comments"].as_array().expect("comments").last().expect("a comment").clone();
    assert_eq!(last["text"], format!("The failing request\n\n{}", log["markdown"].as_str().expect("text")));
    assert_eq!(last["author"], "Claude");
    // after a passage: its own paragraph
    let out = write(
        &mcp,
        "upload",
        json!({"data": STANDARD.encode(PNG), "name": "limits.png", "page_id": made["id"], "find": "Rate limits are not enforced yet."}),
    )
    .await;
    let text = read(&mcp, "get", json!({"page_id": made["id"]})).await["markdown"].as_str().expect("text").to_string();
    assert!(text.contains(&format!("not enforced yet.\n\n{}", out["markdown"].as_str().expect("text"))));
    assert!(fail(&mcp, "upload", json!({"data": "eA==", "name": ".env.json"})).await.contains("never stored"));
    assert!(fail(&mcp, "upload", json!({"data": "eA==", "name": "tool.exe"})).await.contains("not a type"));
    assert!(fail(&mcp, "upload", json!({"data": "%%%", "name": "a.png"})).await.contains("not valid base64"));
    assert!(
        fail(&mcp, "upload", json!({"data": "eA==", "name": "a.txt", "section": "Overview"}))
            .await
            .contains("give page_id")
    );
}

#[tokio::test]
async fn test_a_page_and_a_ticket_see_each_other() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, ticket) = common::rest_ticket(&c, "Rate limiting", "DOC", json!({})).await;
    let tid = ticket["id"].as_str().expect("a ticket id");
    let spec = page(&mcp, &project["id"], "Rate limits spec", &format!("## Scope\n\nWhat {tid} must do.\n")).await;
    let got = call(&mcp, "get_ticket", json!({"ticket_id": tid})).await;
    let docs: Vec<(&Value, &Value)> =
        got["docs"].as_array().expect("docs").iter().map(|d| (&d["page_id"], &d["why"])).collect();
    assert_eq!(docs, [(&spec["id"], &json!(["the page mentions this ticket"]))]);
    let shown = read(&mcp, "get", json!({"page_id": spec["id"]})).await;
    assert_eq!(shown["work"]["tickets"][0]["id"], tid);
    assert!(shown["work"]["tickets"][0]["run"].is_null() && shown["work"]["active"] == 0);
}

#[tokio::test]
async fn test_tickets_from_a_checklist_on_the_page() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, _) = common::rest_ticket(&c, "t", "DOC", json!({})).await;
    let notes = page(
        &mcp,
        &project["id"],
        "Meeting notes",
        "## Actions\n\n- [ ] Hoa to write the CSV export spec, due Friday\n- [x] Drop v1\n- [ ] Tuan to check logs\n",
    )
    .await;
    let out = write(&mcp, "tickets", json!({"page_id": notes["id"]})).await;
    let titles: Vec<&Value> = out["tickets"].as_array().expect("tickets").iter().map(|t| &t["title"]).collect();
    assert_eq!(titles, [&json!("Hoa to write the CSV export spec"), &json!("Tuan to check logs")]);
    let keys: Vec<&str> = out["tickets"].as_array().expect("tickets").iter().filter_map(|t| t["id"].as_str()).collect();
    let text = read(&mcp, "get", json!({"page_id": notes["id"]})).await["markdown"].as_str().expect("text").to_string();
    assert!(text.contains(&format!("- [ ] Hoa to write the CSV export spec, due Friday {}", keys[0])));
    assert!(text.contains(&format!("- [ ] Tuan to check logs {}", keys[1])));
    assert_eq!(out["skipped"][0]["reason"], "ticked");
    let ticket = c.get(&format!("/tickets/{}", keys[0])).await.json();
    assert!(ticket["description"].as_str().expect("text").contains("[[Meeting notes]]"));
    let again = write(&mcp, "tickets", json!({"page_id": notes["id"]})).await;
    assert!(again["tickets"] == json!([]) && again["message"].as_str().expect("text").contains("No unchecked"));
}

#[tokio::test]
async fn test_the_docs_guide_is_one_text_in_both_places() {
    let s = common::start().await;
    let mcp = s.mcp();
    let out = read(&mcp, "docs_guide", json!({})).await;
    assert_eq!(out["guide"], kb_doctext::docs_guide::GUIDE);
    // the guide names the Markdown the editor keeps
    for form in ["==", "> [!WARNING]", "- [ ]", "[[Page#Section]]", "action='edit'", "action='upload'"] {
        assert!(kb_doctext::docs_guide::GUIDE.contains(form), "{form}");
    }
}

#[tokio::test]
async fn test_an_import_by_an_agent_is_published_and_a_draft_is_never_dropped_by_an_edit() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, _) = common::rest_ticket(&c, "t", "RES", json!({})).await;
    let pid = &project["id"];
    let dir = tempfile::tempdir().expect("a folder");
    let note = dir.path().join("RES-1-research.md");
    std::fs::write(
        &note,
        "# Research\n\n## Parsing\n\nTree-sitter for every language.\n\n## Storage\n\nSQLite and FTS5.\n",
    )
    .expect("a file");
    let out = write(&mcp, "import", json!({"project_id": pid, "path": note.to_string_lossy()})).await;
    assert!(out["published"] == true && common::truthy(&out["created"]));
    let page_id = out["created"][0]["page_id"].clone();
    let shown = read(&mcp, "get", json!({"page_id": page_id})).await;
    assert!(shown["version"] == 1 && shown["markdown"].as_str().expect("text").contains("## Storage"));
    let edited = write(&mcp, "edit", json!({"page_id": page_id, "find": "SQLite and FTS5.", "markdown": "SQLite and FTS5, one file.", "mode": "replace"})).await;
    assert_eq!(edited["version"], 2);

    // publish=false keeps the old behaviour on request, says so, and an edit then refuses instead of losing it
    let drafted =
        write(&mcp, "import", json!({"project_id": pid, "path": note.to_string_lossy(), "publish": false})).await;
    assert!(drafted["published"] == false && drafted["note"].as_str().expect("text").contains("drafts"));
    let draft_id = drafted["created"][0]["page_id"].clone();
    let refused =
        fail(&mcp, "edit", json!({"page_id": draft_id, "find": "the end", "markdown": "One more line."})).await;
    assert!(refused.contains("unpublished draft"), "{refused}");
    let empty = read(&mcp, "get", json!({"page_id": draft_id})).await;
    assert_eq!(empty["markdown"].as_str().expect("text").trim(), "");
}
