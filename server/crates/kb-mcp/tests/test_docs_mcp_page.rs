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

#[tokio::test]
async fn a_book_exports_its_chapters_and_the_tree_reads_in_order() {
    if !skip_unless_available("a_book_exports_its_chapters_and_the_tree_reads_in_order") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let mk = |title: &str, parent: Option<&Value>| {
        let mut a = json!({"project_id": pid, "title": title, "markdown": format!("Text of {title}.")});
        if let Some(p) = parent {
            a["parent_id"] = p.clone();
        }
        a
    };
    let other = write(&mcp, "create", mk("Other", None)).await["id"].clone();
    let book = write(&mcp, "create", mk("Harbour Lights", None)).await["id"].clone();
    write(&mcp, "settings", json!({"page_id": book, "settings": {"book": {"isBook": true}}})).await;
    let one = write(&mcp, "create", mk("One", Some(&book))).await["id"].clone();
    let two = write(&mcp, "create", mk("Two", Some(&book))).await["id"].clone();
    let late = write(&mcp, "create", mk("Late", None)).await["id"].clone();
    // `after_id` alone moves to that sibling's level: Two before One, inside the book
    write(&mcp, "move", json!({"page_id": one, "after_id": two})).await;
    let order: Vec<Value> = read(&mcp, "list", json!({"project_id": pid}))
        .await
        .as_array()
        .expect("a list")
        .iter()
        .map(|p| p["title"].clone())
        .collect();
    assert_eq!(order, json!(["Other", "Harbour Lights", "Two", "One", "Late"]).as_array().cloned().expect("titles"));
    // before_id of the first sibling makes it first
    write(&mcp, "move", json!({"page_id": one, "before_id": two})).await;
    let chapters: Vec<Value> = read(&mcp, "list", json!({"project_id": pid}))
        .await
        .as_array()
        .expect("a list")
        .iter()
        .filter(|p| p["parent_id"] == book)
        .map(|p| p["title"].clone())
        .collect();
    assert_eq!(chapters, [json!("One"), json!("Two")]);
    let both =
        call_err(&mcp, "docs_write", json!({"action": "move", "page_id": one, "after_id": two, "before_id": two}))
            .await;
    assert!(both.contains("not both"), "{both}");
    let _ = other;

    let dir = tempfile::tempdir().expect("a folder");
    let file = dir.path().join("book.md");
    // from the book page or from a chapter: the chapters, in order; several files come as a .zip
    for from in [&book, &two] {
        let got = read(
            &mcp,
            "export",
            json!({"page_id": from, "scope": "book", "format": "md", "path": file.to_str().expect("utf-8")}),
        )
        .await;
        let path = got["path"].as_str().expect("a path");
        if got.get("zip").is_some() {
            assert!(path.ends_with(".zip"), "{got}");
        } else {
            let text = std::fs::read_to_string(path).expect("the file");
            assert!(text.find("Text of One").expect("One") < text.find("Text of Two").expect("Two"), "{text}");
        }
    }
    // a book in Word carries the book's title, not "Book"
    let docx = dir.path().join("book.docx");
    let got = read(
        &mcp,
        "export",
        json!({"page_id": book, "scope": "book", "format": "docx", "path": docx.to_str().expect("utf-8")}),
    )
    .await;
    let opened = std::fs::File::open(got["path"].as_str().expect("a path")).expect("the file");
    let mut zip = zip::ZipArchive::new(opened).expect("a docx is a zip");
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("word/document.xml").expect("its text"), &mut xml).expect("read");
    assert!(xml.contains("Harbour Lights") && xml.contains("Text of One"), "the book's title and chapters");
    // into a folder: the file is named after the book
    let named = read(
        &mcp,
        "export",
        json!({"page_id": two, "scope": "book", "format": "docx", "path": dir.path().to_str().expect("utf-8")}),
    )
    .await;
    assert!(named["path"].as_str().expect("a path").ends_with("Harbour Lights.docx"), "{named}");
    let lonely = call_err(
        &mcp,
        "docs_read",
        json!({"action": "export", "page_id": late, "scope": "book", "path": file.to_str().expect("utf-8")}),
    )
    .await;
    assert!(lonely.contains("scope='page'"), "{lonely}");
}

#[tokio::test]
async fn history_pictures_and_the_guide_are_short() {
    if !skip_unless_available("history_pictures_and_the_guide_are_short") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let body: String = (1..=12).map(|i| format!("Line {i}.\n\n")).collect();
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Long", "markdown": body})).await;
    let id = made["id"].clone();
    for v in 1..=3 {
        write(
            &mcp,
            "edit",
            json!({"page_id": id, "find": format!("Line {}.", v * 3), "markdown": format!("Changed {v}.")}),
        )
        .await;
    }
    let old = read(&mcp, "version", json!({"page_id": id, "version": 1})).await;
    assert!(old["markdown"].as_str().is_some_and(|m| m.contains("Line 3.")) && old.get("content").is_none(), "{old}");
    let assign = call_err(
        &mcp,
        "docs_write",
        json!({"action": "assign", "page_id": id, "member_id": "nobody", "kind": "review"}),
    )
    .await;
    assert!(assign.contains("get_projects") && assign.contains("AI Team"), "{assign}");
    let versions = read(&mcp, "versions", json!({"page_id": id, "limit": 2})).await;
    assert_eq!(versions.as_array().map(Vec::len), Some(2), "{versions}");
    let diff = read(&mcp, "version", json!({"page_id": id, "version": 1, "compare_to": 4})).await;
    let text = diff["diff"].as_str().expect("a diff");
    assert!(text.contains("- Line 3.") && text.contains("+ Changed 1.") && text.contains('…'), "{text}");
    assert!(!text.contains("Line 12.") && diff.get("rows").is_none(), "only the changes and their context: {diff}");

    // not in a dot folder: an upload never takes a file from one
    let dir = tempfile::Builder::new().prefix("docs-upload").tempdir().expect("a folder");
    let png = dir.path().join("dot.png");
    // a 1x1 PNG
    let bytes: [u8; 67] = [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21,
        196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69,
        78, 68, 174, 66, 96, 130,
    ];
    std::fs::write(&png, bytes).expect("write the picture");
    let up = write(&mcp, "upload", json!({"path": png.to_str().expect("utf-8"), "alt": "A green dot"})).await;
    assert!(up["markdown"].as_str().expect("markdown").starts_with("![A green dot](/uploads/"), "{up}");
    assert!(up.get("stored_in").is_none(), "{up}");

    let part = read(&mcp, "docs_guide", json!({"section": "settings"})).await;
    let guide = part["guide"].as_str().expect("a part");
    assert!(guide.starts_with("## 6. The page") && !guide.contains("## 7."), "{guide}");
    assert!(part["sections"].as_array().is_some_and(|s| s.len() >= 10), "{part}");
    let numbered = read(&mcp, "docs_guide", json!({"section": "5"})).await;
    assert!(numbered["guide"].as_str().expect("a part").starts_with("## 5. The annotated Markdown"));
    let none = call_err(&mcp, "docs_read", json!({"action": "docs_guide", "section": "cooking"})).await;
    assert!(none.contains("no section 'cooking'"), "{none}");
}

/// Every form the formatting summary of docs_write's description shows is read as it says: an agent copies them.
#[tokio::test]
async fn the_formatting_summary_of_the_description_works_as_written() {
    if !skip_unless_available("the_formatting_summary_of_the_description_works_as_written") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let listed = common::tools(&mcp).await;
    let text = listed["docs_write"]["description"].as_str().expect("a description");
    for form in [
        "`<!-- align=center -->`",
        "`dropcap=3`",
        "`placement=floatRight width=40 caption=\"…\"`",
        "`banded=true caption=\"…\"`",
        "`> [!INFO]`",
        "`[words]{color=red}`",
        "`{highlight=yellow}`",
        "`{.underline}`",
    ] {
        assert!(text.contains(form), "the summary shows {form}");
    }
    let pid = project(&c).await;
    let markdown = "<!-- align=center -->\n## Title\n\n<!-- dropcap=3 -->\nOnce upon a time.\n\n\
        <!-- placement=floatRight width=40 caption=\"A dot\" -->\n![A dot](/uploads/dot.png)\n\n\
        <!-- banded=true caption=\"Plans\" -->\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n\
        > [!INFO]\n> Note this.\n\n\
        Some [red]{color=red}, [marked]{highlight=yellow} and [lined]{.underline} words.\n";
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Forms", "markdown": markdown})).await;
    let page = c.get(&format!("/docs/pages/{}", made["id"].as_str().expect("an id"))).await.json();
    let blocks = page["content"]["content"].as_array().expect("blocks").clone();
    let attrs = |i: usize| blocks[i]["attrs"].clone();
    assert_eq!(attrs(0)["textAlign"], "center");
    assert_eq!(attrs(1)["dropCap"], 3);
    assert_eq!(
        (&attrs(2)["placement"], &attrs(2)["widthPct"], &attrs(2)["caption"]),
        (&json!("floatRight"), &json!(40), &json!("A dot"))
    );
    assert_eq!((&attrs(3)["banded"], &attrs(3)["caption"]), (&json!(true), &json!("Plans")));
    // info is the callout's default kind: it is not written out
    assert!(
        blocks[4]["type"] == "callout" && [json!(null), json!("info")].contains(&attrs(4)["kind"]),
        "{}",
        blocks[4]
    );
    let words = blocks[5].to_string();
    for mark in ["\"color\":\"red\"", "\"highlight\"", "\"underline\""] {
        assert!(words.contains(mark), "{mark}: {words}");
    }
    // the table cells and the settings it shows
    for form in [
        "cells='A1:C1', attrs={\"background\": \"green\"}",
        "border \"top bottom\"",
        "width (narrow, normal, wide, full)",
        "bodyFont (jakarta, lora, inter, playfair",
        "book {\"isBook\": true}",
        "upload alt",
    ] {
        assert!(text.contains(form), "the summary shows {form}");
    }
    let table = blocks[3]["attrs"]["blockId"].as_str().expect("an id").to_string();
    let id = made["id"].as_str().expect("an id");
    write(
        &mcp,
        "edit",
        json!({"page_id": id, "block_id": table, "mode": "attrs", "cells": "A1:B1",
                               "attrs": {"background": "green", "align": "center", "padding": "roomy"}}),
    )
    .await;
    write(
        &mcp,
        "edit",
        json!({"page_id": id, "block_id": table, "mode": "attrs", "cells": "B2", "attrs": {"border": "top bottom"}}),
    )
    .await;
    let cells = read(&mcp, "block", json!({"page_id": id, "block_id": table})).await["cells"].clone();
    assert_eq!(cells["A1"], json!({"align": "center", "background": "green", "padding": "roomy"}));
    assert_eq!(cells["B2"], json!({"border": "top bottom"}));
    for font in ["jakarta", "lora", "inter", "playfair"] {
        write(&mcp, "settings", json!({"page_id": id, "settings": {"bodyFont": font}})).await;
    }
    let set = write(
        &mcp,
        "settings",
        json!({"page_id": id, "settings": {"width": "wide", "titleAlign": "center",
        "eyebrow": "Field notes", "cover": {"color": "#2e6f40"}, "book": {"isBook": true}}}),
    )
    .await;
    assert_eq!(set["settings"]["width"], "wide");
    assert_eq!(set["settings"]["book"]["isBook"], true);
}
