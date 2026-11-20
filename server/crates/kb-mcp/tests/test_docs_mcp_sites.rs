//! HTML embeds from a folder through MCP: `docs_write(upload)` of a folder, a `.zip` or an `.html` file makes a site
//! and answers the embed's marker (placed on a page when `page_id` is given); `markdown_file` gives `create`,
//! `update` and `edit` their text from a file; an `edit` turns a code block into an HTML embed.
//!
//! The tests start the board's own server (`target/debug/kanban-server`), which serves the sites' files.

mod common;

use std::io::Write;

use base64::Engine;
use common::{call, call_err};
use serde_json::{Value, json};
use testkit::{Client, Mcp, Server, skip_unless_available};

async fn project(c: &Client) -> String {
    let made = c.post("/projects", json!({"name": "Sites", "prefix": "STE", "color": "#123456"})).await;
    made.assert_status(201);
    made.json()["id"].as_str().expect("an id").to_string()
}

async fn write(mcp: &Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_write", arguments).await
}

async fn write_err(mcp: &Mcp, action: &str, rest: Value) -> String {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call_err(mcp, "docs_write", arguments).await
}

/// The top-level blocks of a page as the app reads it.
async fn blocks(c: &Client, page_id: &str) -> Vec<Value> {
    let r = c.get(&format!("/docs/pages/{page_id}")).await;
    r.assert_status(200);
    r.json()["content"]["content"].as_array().expect("blocks").clone()
}

#[tokio::test]
async fn a_folder_becomes_a_site_and_its_embed_goes_on_the_page() {
    if !skip_unless_available("a_folder_becomes_a_site_and_its_embed_goes_on_the_page") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Globe", "markdown": "Our globe:"})).await;
    let page_id = made["id"].as_str().expect("an id").to_string();

    let dir = tempfile::Builder::new().prefix("kb-sites").tempdir().expect("a folder");
    let site = dir.path().join("globe");
    std::fs::create_dir_all(site.join("js")).expect("folders");
    std::fs::write(site.join("index.html"), "<script src=\"js/app.js\"></script><canvas></canvas>").expect("write");
    std::fs::write(site.join("js/app.js"), "console.log('spin')").expect("write");
    std::fs::create_dir_all(site.join(".git")).expect("folders");
    std::fs::write(site.join(".git/HEAD"), "ref").expect("write");

    let out = write(&mcp, "upload", json!({"path": site.to_string_lossy(), "page_id": page_id})).await;
    let url = out["url"].as_str().expect("a url").to_string();
    assert!(url.starts_with("/docs/sites/") && url.ends_with("/index.html"), "{out}");
    assert_eq!(out["entry"], json!("index.html"));
    assert_eq!(out["files"], json!(2), "the .git folder is left out: {out}");
    assert_eq!(out["markdown"], json!(format!("<!-- htmlEmbed src=\"{url}\" title=\"globe\" -->")));
    assert!(out["page"]["version"].as_i64().is_some(), "{out}");
    // the page holds the embed, and the site is served
    let embed = blocks(&c, &page_id).await.into_iter().find(|b| b["type"] == "htmlEmbed").expect("an embed");
    assert_eq!(embed["attrs"]["src"], json!(url));
    assert_eq!(embed["attrs"]["title"], json!("globe"));
    let served = c.get(&url).await;
    assert_eq!(served.status, 200);
    assert!(served.text().contains("<canvas>"));
    // the MCP view writes the embed as its marker alone
    let got = call(&mcp, "docs_read", json!({"action": "get", "page_id": page_id})).await;
    let md = got["markdown"].as_str().expect("markdown");
    assert!(md.contains(&format!("htmlEmbed src={url} title=globe -->")), "{md}");

    // one .html file, by its path; a .zip as data
    let one = dir.path().join("Report.html");
    std::fs::write(&one, "<h1>Report</h1>").expect("write");
    let out = write(&mcp, "upload", json!({"path": one.to_string_lossy()})).await;
    assert_eq!(out["entry"], json!("Report.html"));
    assert!(out["markdown"].as_str().expect("text").ends_with("title=\"Report\" -->"), "{out}");
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        z.start_file("demo/index.html", zip::write::SimpleFileOptions::default()).expect("zip");
        z.write_all(b"<p>zip</p>").expect("zip");
        z.finish().expect("zip");
    }
    let data = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    let out = write(&mcp, "upload", json!({"data": data, "name": "demo.zip"})).await;
    assert_eq!(c.get(out["url"].as_str().expect("a url")).await.text(), "<p>zip</p>");
    // a folder without a page at the top
    let bare = dir.path().join("bare");
    std::fs::create_dir_all(&bare).expect("folder");
    std::fs::write(bare.join("a.css"), "p{}").expect("write");
    let err = write_err(&mcp, "upload", json!({"path": bare.to_string_lossy()})).await;
    assert!(err.contains("no .html page"), "{err}");
    // other files are stored as before
    let note = dir.path().join("note.txt");
    std::fs::write(&note, "hello").expect("write");
    let out = write(&mcp, "upload", json!({"path": note.to_string_lossy()})).await;
    assert!(out["url"].as_str().expect("a url").starts_with("/uploads/"), "{out}");
}

#[tokio::test]
async fn markdown_file_gives_create_update_and_edit_their_text() {
    if !skip_unless_available("markdown_file_gives_create_update_and_edit_their_text") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let dir = tempfile::Builder::new().prefix("kb-sites").tempdir().expect("a folder");
    let file = dir.path().join("page.md");
    let big = "<canvas></canvas>".repeat(2000);
    std::fs::write(
        &file,
        format!("\u{feff}# Scene\n\n<!-- htmlEmbed title=\"Scene\" height=600 -->\n```html\n{big}\n```\n"),
    )
    .expect("write");
    let path = file.to_string_lossy().to_string();
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Scene", "markdown_file": path})).await;
    let page_id = made["id"].as_str().expect("an id").to_string();
    let found = blocks(&c, &page_id).await;
    let embed = found.iter().find(|b| b["type"] == "htmlEmbed").expect("an embed");
    assert_eq!(embed["attrs"]["html"], json!(big));
    assert_eq!(found[0]["type"], json!("heading"), "the byte order mark is dropped");

    std::fs::write(&file, "# Scene\n\nNew text.\n").expect("write");
    let version = made["version"].as_i64().expect("a version");
    write(&mcp, "update", json!({"page_id": page_id, "markdown_file": path, "base_version": version})).await;
    let found = blocks(&c, &page_id).await;
    assert!(found.iter().any(|b| b["content"][0]["text"] == "New text."), "{found:?}");

    let err = write_err(&mcp, "update", json!({"page_id": page_id, "markdown": "x", "markdown_file": path})).await;
    assert!(err.contains("not both"), "{err}");
    let err = write_err(&mcp, "comment", json!({"page_id": page_id, "body": "x", "markdown_file": path})).await;
    assert!(err.contains("does not use: markdown_file"), "{err}");
    let err = write_err(&mcp, "create", json!({"project_id": pid, "title": "X", "markdown_file": "page.md"})).await;
    assert!(err.contains("absolute path"), "{err}");
    let missing = dir.path().join("missing.md").to_string_lossy().to_string();
    let err = write_err(&mcp, "create", json!({"project_id": pid, "title": "X", "markdown_file": missing})).await;
    assert!(err.contains("is not a file"), "{err}");
}

#[tokio::test]
async fn an_edit_turns_a_code_block_into_an_html_embed() {
    if !skip_unless_available("an_edit_turns_a_code_block_into_an_html_embed") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let pid = project(&c).await;
    let md = "Intro.\n\n```html\n<div id=globe></div>\n<script>spin()</script>\n```\n";
    let made = write(&mcp, "create", json!({"project_id": pid, "title": "Code", "markdown": md})).await;
    let page_id = made["id"].as_str().expect("an id").to_string();
    let code = blocks(&c, &page_id).await.into_iter().find(|b| b["type"] == "codeBlock").expect("a code block");
    let block_id = code["attrs"]["blockId"].as_str().expect("an id").to_string();
    write(
        &mcp,
        "edit",
        json!({"page_id": page_id, "block_id": block_id, "mode": "attrs",
               "attrs": {"type": "htmlEmbed", "title": "Globe", "height": 480}}),
    )
    .await;
    let embed = blocks(&c, &page_id).await.into_iter().find(|b| b["attrs"]["blockId"] == block_id).expect("the block");
    assert_eq!(embed["type"], json!("htmlEmbed"));
    assert_eq!(embed["attrs"]["html"], json!("<div id=globe></div>\n<script>spin()</script>"));
    assert_eq!(embed["attrs"]["title"], json!("Globe"));
    assert_eq!(embed["attrs"]["height"], json!(480));
}
