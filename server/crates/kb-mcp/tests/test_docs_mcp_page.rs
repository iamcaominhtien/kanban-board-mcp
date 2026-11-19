//! The page-level Docs tools: settings (`docs_write(settings)`, and `create` with `settings`), templates
//! (`docs_read(templates)`, `create` with `template`), export to a file (`docs_read(export)`), the format of a
//! table's cells (`edit` with `cells`, read back by `docs_read(block)`), and the short answers of the Docs tools
//! (one line of JSON, nothing empty, `plain` Markdown).
//!
//! The tests start the board's own server (`target/debug/kanban-server`), as `test_docs_mcp_rich` does.

mod common;

use common::{call, call_err};
use serde_json::{Value, json};
use testkit::{Client, Mcp, Server, skip_unless_available};

async fn project(c: &Client) -> String {
    let made = c.post("/projects", json!({"name": "Pages", "prefix": "PGS", "color": "#123456"})).await;
    made.assert_status(201);
    made.json()["id"].as_str().expect("an id").to_string()
}

async fn read(mcp: &Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_read", arguments).await
}

async fn write(mcp: &Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_write", arguments).await
}

const TABLE: &str = "## Plans\n\n| Plan | Price |\n| --- | --- |\n| Free | 0 |\n| Team | 8 |\n";

#[tokio::test]
async fn settings_are_set_read_back_and_reset() {
    if !skip_unless_available("settings_are_set_read_back_and_reset") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let made = write(
        &mcp,
        "create",
        json!({"project_id": pid, "title": "Story", "markdown": "Once.", "settings": {"bodyFont": "lora"}}),
    )
    .await;
    let id = made["id"].as_str().expect("an id");
    let got = read(&mcp, "get", json!({"page_id": id})).await;
    assert_eq!(got["settings"], json!({"bodyFont": "lora"}));

    let set = write(
        &mcp,
        "settings",
        json!({"page_id": id, "settings": {"cover": {"color": "#2e6f40", "height": "m"}, "titleAlign": "center",
                                           "book": {"isBook": true}}}),
    )
    .await;
    assert_eq!(set["settings"]["titleAlign"], "center");
    assert_eq!(set["settings"]["cover"]["color"], "#2e6f40");
    let reset = write(&mcp, "settings", json!({"page_id": id, "settings": {"bodyFont": null}})).await;
    assert!(reset["settings"].get("bodyFont").is_none() && reset["settings"]["titleAlign"] == "center", "{reset}");

    let bad =
        call_err(&mcp, "docs_write", json!({"action": "settings", "page_id": id, "settings": {"width": "huge"}})).await;
    assert!(bad.contains("width"), "{bad}");
    let unknown =
        call_err(&mcp, "docs_write", json!({"action": "settings", "page_id": id, "settings": {"colour": "red"}})).await;
    assert!(unknown.contains("Unknown page setting 'colour'"), "{unknown}");
    let empty = call_err(&mcp, "docs_write", json!({"action": "settings", "page_id": id, "settings": {}})).await;
    assert!(empty.contains("at least one key"), "{empty}");
}

#[tokio::test]
async fn a_page_starts_from_a_template() {
    if !skip_unless_available("a_page_starts_from_a_template") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let templates = read(&mcp, "templates", json!({"project_id": pid})).await;
    let list = templates.as_array().expect("a list");
    let blog = list.iter().find(|t| t["name"] == "Blog post").unwrap_or_else(|| panic!("{templates}"));
    assert_eq!(blog["from"], "builtin");
    assert!(list.iter().all(|t| t["id"].is_string() && t.get("preview").is_none()), "short rows: {templates}");

    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Our year", "template": blog["id"]})).await;
    assert_eq!((&made["status"], &made["version"]), (&json!("published"), &json!(1)));
    let got = read(&mcp, "get", json!({"page_id": made["id"]})).await;
    assert!(got["markdown"].as_str().expect("markdown").contains("## What happened"), "{got}");
    assert!(got["settings"].is_object(), "the template's settings come with it: {got}");

    let both = call_err(
        &mcp,
        "docs_write",
        json!({"action": "create", "project_id": pid, "title": "x", "template": blog["id"], "markdown": "Hi"}),
    )
    .await;
    assert!(both.contains("template or markdown"), "{both}");
    let unknown = call_err(
        &mcp,
        "docs_write",
        json!({"action": "create", "project_id": pid, "title": "x", "template": "no-such-template"}),
    )
    .await;
    assert!(unknown.contains("Unknown template"), "{unknown}");
}

#[tokio::test]
async fn a_page_is_exported_to_a_file() {
    if !skip_unless_available("a_page_is_exported_to_a_file") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Runbook", "markdown": TABLE})).await;
    let dir = tempfile::tempdir().expect("a folder");
    let folder = dir.path().to_str().expect("utf-8");
    let md = read(&mcp, "export", json!({"page_id": made["id"], "path": folder})).await;
    let path = md["path"].as_str().expect("a path");
    assert!(path.starts_with(folder) && path.ends_with(".md"), "{md}");
    assert!(std::fs::read_to_string(path).expect("the file").contains("| Team | 8 |"));

    let file = dir.path().join("out.html");
    let html =
        read(&mcp, "export", json!({"page_id": made["id"], "path": file.to_str().expect("utf-8"), "format": "html"}))
            .await;
    assert_eq!(html["path"], json!(file.to_str()));
    assert!(std::fs::read_to_string(&file).expect("the file").contains("<table"));

    let relative =
        call_err(&mcp, "docs_read", json!({"action": "export", "page_id": made["id"], "path": "out.md"})).await;
    assert!(relative.contains("absolute path"), "{relative}");
}

#[tokio::test]
async fn table_cells_are_formatted_by_name_and_read_back() {
    if !skip_unless_available("table_cells_are_formatted_by_name_and_read_back") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Prices", "markdown": TABLE})).await;
    let id = made["id"].as_str().expect("an id");
    let got = read(&mcp, "get", json!({"page_id": id})).await;
    let md = got["markdown"].as_str().expect("markdown");
    let at = md.find("| Plan").expect("the table");
    let marker = md[..at].rfind("<!-- #b-").expect("its marker");
    let table = &md[marker + 6..marker + 14];

    write(
        &mcp,
        "edit",
        json!({"page_id": id, "block_id": table, "mode": "attrs", "cells": "A1:B1",
               "attrs": {"background": "green", "padding": "roomy"}}),
    )
    .await;
    write(
        &mcp,
        "edit",
        json!({"page_id": id, "block_id": table, "mode": "attrs", "cells": "B3", "attrs": {"border": "top bottom"}}),
    )
    .await;
    let block = read(&mcp, "block", json!({"page_id": id, "block_id": table})).await;
    assert_eq!(
        block["cells"],
        json!({"A1": {"background": "green", "padding": "roomy"}, "B1": {"background": "green", "padding": "roomy"},
               "B3": {"border": "top bottom"}})
    );
    // the table's own format stays a marker attribute, the cells' stay with the cells when its words change
    write(&mcp, "edit", json!({"page_id": id, "block_id": table, "mode": "attrs", "attrs": {"banded": true}})).await;
    write(&mcp, "edit", json!({"page_id": id, "find": "| Team | 8 |", "markdown": "| Team | 9 |"})).await;
    let block = read(&mcp, "block", json!({"page_id": id, "block_id": table})).await;
    assert!(block["markdown"].as_str().expect("markdown").contains("banded=true"), "{block}");
    assert_eq!(block["cells"]["B3"], json!({"border": "top bottom"}));

    for (cells, attrs, says) in [
        ("C9", json!({"background": "green"}), "outside the table"),
        ("9Z", json!({"background": "green"}), "is not a cell"),
        ("A1", json!({"colspan": 2}), "the table's shape"),
        ("A1", json!({"padding": "huge"}), "padding"),
    ] {
        let refused = call_err(
            &mcp,
            "docs_write",
            json!({"action": "edit", "page_id": id, "block_id": table, "mode": "attrs", "cells": cells,
                   "attrs": attrs}),
        )
        .await;
        assert!(refused.contains(says), "{cells}: {refused}");
    }
}

#[tokio::test]
async fn the_answers_are_short() {
    if !skip_unless_available("the_answers_are_short") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Runbook", "markdown": TABLE})).await;
    let id = made["id"].as_str().expect("an id");
    // one line of JSON, a list in one block
    let raw = mcp.call_tool("docs_read", json!({"action": "get", "page_id": id})).await;
    assert!(!raw.text.contains("\n  \""), "not indented: {}", raw.text);
    assert!(raw.raw.get("structuredContent").is_none(), "the answer is sent once");
    let listed = mcp.call_tool("docs_read", json!({"action": "list", "project_id": pid})).await;
    assert_eq!(listed.raw["content"].as_array().map(Vec::len), Some(1), "{:?}", listed.raw);
    assert_eq!(listed.json(), json!([{"id": id, "parent_id": null, "title": "Runbook", "status": "published"}]));
    // nothing empty, no duplicates of what the Markdown already says
    let got = read(&mcp, "get", json!({"page_id": id})).await;
    for key in ["highlights", "referenced_by", "headings", "slug", "project_id", "format", "settings"] {
        assert!(got.get(key).is_none(), "{key}: {got}");
    }
    let plain = read(&mcp, "get", json!({"page_id": id, "plain": true})).await;
    assert_eq!(plain["markdown"], json!(TABLE));
    let part = read(&mcp, "get", json!({"page_id": id, "section": "Plans"})).await;
    assert_eq!(part["sections"], json!(["## Plans"]));
}
