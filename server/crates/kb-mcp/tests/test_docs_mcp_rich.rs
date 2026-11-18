//! Rich Docs through MCP (`server/contract/richdoc/README.md`, "Annotated"): `docs_read(get)` gives a page as
//! Markdown with a block marker before every block and the readers' highlights, `docs_read(block)` one block in full,
//! and `docs_write(edit)` changes one block by its id (replace, after, delete, attrs) while every other block keeps
//! its id and formatting. `update` keeps the placeholders it leaves out. An AI team's change waits as suggestions
//! (or is published, when the page applies a team's changes directly), a block locked for teams is left alone, and a
//! page marked "Not for AI teams" is refused to a team.
//!
//! The tests start the board's own server (`target/debug/kanban-server`): its MCP endpoint knows an AI run by the
//! run's token, which this crate's test server does not.

mod common;

use std::time::Duration;

use common::{call, call_err};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions};
use sqlx::{Arguments, ConnectOptions, Connection};
use testkit::{Client, Mcp, Server, skip_unless_available};

const NOW: &str = "2026-11-17T08:00:00.000000+00:00";
/// The token of the AI team's run (`kbr_…`: the board's run tokens).
const TOKEN: &str = "kbr_test_docs_team";

async fn exec(s: &Server, sql: &str, params: &[Value]) {
    let mut args = SqliteArguments::default();
    for p in params {
        match p {
            Value::Null => args.add(Option::<String>::None),
            Value::Bool(b) => args.add(*b),
            Value::Number(n) if n.is_i64() => args.add(n.as_i64()),
            Value::Number(n) => args.add(n.as_f64()),
            Value::String(t) => args.add(t.clone()),
            other => args.add(other.to_string()),
        }
        .expect("bind");
    }
    let mut c = SqliteConnectOptions::new()
        .filename(s.db_path())
        .busy_timeout(Duration::from_secs(10))
        .foreign_keys(false)
        .disable_statement_logging()
        .connect()
        .await
        .expect("open the database");
    sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), args)
        .execute(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let _ = c.close().await;
}

/// The first column of the first row a query returns, as text (`None` for NULL).
async fn query_one(s: &Server, sql: &str, params: &[Value]) -> Value {
    let mut args = SqliteArguments::default();
    for p in params {
        args.add(p.as_str().map(str::to_string)).expect("bind");
    }
    let mut c = SqliteConnectOptions::new()
        .filename(s.db_path())
        .busy_timeout(Duration::from_secs(10))
        .disable_statement_logging()
        .connect()
        .await
        .expect("open the database");
    let row = sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), args)
        .fetch_one(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let text: Option<String> = sqlx::Row::get(&row, 0);
    let _ = c.close().await;
    text.map_or(Value::Null, Value::String)
}

async fn insert(s: &Server, table: &str, columns: Value) {
    let columns = columns.as_object().expect("columns");
    let names: Vec<String> = columns.keys().map(|k| format!("\"{k}\"")).collect();
    let marks = vec!["?"; names.len()].join(", ");
    let values: Vec<Value> = columns.values().cloned().collect();
    exec(s, &format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", ")), &values).await;
}

/// An AI team of the project ("Docs team") with a running run whose token is [`TOKEN`].
async fn ai_team(s: &Server, project_id: &str) -> String {
    let id = "mem_docs_team".to_string();
    insert(
        s,
        "member",
        json!({"id": id, "project_id": project_id, "name": "Docs team", "color": "#8B5CF6", "created_at": NOW,
               "role": "member", "kind": "ai"}),
    )
    .await;
    insert(
        s,
        "ai_team",
        json!({"id": id, "project_id": project_id, "provider": "claude-code", "connection": "local",
               "description": "", "persona": "", "config": "{}", "permission_mode": "bypass", "max_parallel": 2,
               "scope": "assigned", "paused": false, "health": "unknown", "model": "stand-in", "created_at": NOW,
               "updated_at": NOW}),
    )
    .await;
    let hash: String = Sha256::digest(TOKEN.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    insert(
        s,
        "ai_run",
        json!({"id": "run_docs", "kind": "team", "number": 1, "mode": "work", "trigger": "assign", "state": "running",
               "started_by": "An Nguyen", "instruction": "", "queued_at": NOW, "report": "{}", "files": "[]",
               "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0, "metered": false, "paused": false, "restarts": "[]",
               "retries": "[]", "steps_count": 0, "live": false, "depth": 0, "token_hash": hash,
               "member_id": id, "project_id": project_id}),
    )
    .await;
    id
}

async fn project(c: &Client) -> String {
    let made = c.post("/projects", json!({"name": "Rich", "prefix": "RCH", "color": "#123456"})).await;
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

/// The page as the app reads it (rich JSON in `content`).
async fn page(c: &Client, page_id: &str) -> Value {
    let r = c.get(&format!("/docs/pages/{page_id}")).await;
    r.assert_status(200);
    r.json()
}

/// The top-level blocks of a page's content.
fn blocks(page: &Value) -> Vec<Value> {
    page["content"]["content"].as_array().expect("blocks").clone()
}

fn id_of(block: &Value) -> String {
    block["attrs"]["blockId"].as_str().expect("a block id").to_string()
}

fn by_id(page: &Value, id: &str) -> Option<Value> {
    blocks(page).into_iter().find(|b| b["attrs"]["blockId"] == id)
}

/// The block id of the first marker followed by a block whose Markdown contains `text`.
fn marker_before(markdown: &str, text: &str) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let at = lines.iter().position(|l| l.contains(text)).unwrap_or_else(|| panic!("{text} in {markdown}"));
    let marker = lines[..at].iter().rev().find(|l| l.starts_with("<!-- #b-")).expect("a marker");
    marker["<!-- #".len().."<!-- #".len() + 8].to_string()
}

const POST: &str = "<!-- align=center -->
## Why we moved our roadmap

<!-- placement=floatRight width=40 caption=\"Planning night\" -->
![Six people at a table](/uploads/team.png)

We kept the roadmap in a slide deck for two years.

<!-- pullQuote -->
> The pages did the work the meetings used to do.

## Details

Tickets stay small and pages stay short.
";

/// A page an agent created through MCP from annotated Markdown: (project id, page id).
async fn post_page(c: &Client, mcp: &Mcp) -> (String, String) {
    let pid = project(c).await;
    let made = write(mcp, "create", json!({"project_id": pid, "title": "Roadmap", "markdown": POST})).await;
    (pid, made["id"].as_str().expect("an id").to_string())
}

#[tokio::test]
async fn get_shows_block_markers_formatting_and_highlights() {
    if !skip_unless_available("get_shows_block_markers_formatting_and_highlights") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let (_, page_id) = post_page(&c, &mcp).await;
    let stored = page(&c, &page_id).await;
    let kinds: Vec<String> =
        blocks(&stored).iter().map(|b| b["type"].as_str().unwrap_or_default().to_string()).collect();
    assert_eq!(&kinds[..4], ["heading", "image", "paragraph", "pullQuote"]);
    assert_eq!(blocks(&stored)[0]["attrs"]["textAlign"], "center");
    assert_eq!(blocks(&stored)[1]["attrs"]["placement"], "floatRight");

    let got = read(&mcp, "get", json!({"page_id": page_id})).await;
    assert_eq!(got["format"], "rich");
    let md = got["markdown"].as_str().expect("markdown");
    let first = id_of(&blocks(&stored)[0]);
    assert!(md.starts_with(&format!("<!-- #{first} align=center -->\n## Why we moved our roadmap")), "{md}");
    assert!(md.contains("placement=floatRight") && md.contains("caption=\"Planning night\""), "{md}");
    assert!(md.contains("pullQuote -->\n> The pages did"), "{md}");
    assert_eq!(md.matches("<!-- #b-").count(), blocks(&stored).len(), "one marker per block: {md}");
    assert_eq!(got["highlights"], json!([]));

    // a reader highlights a passage: the team reads it as a hint (author, colour, quote, block)
    let para = id_of(&blocks(&stored)[2]);
    let body = json!({"block_id": para, "start": 8, "end": 19, "quote": "the roadmap", "color": "green"});
    c.post(&format!("/docs/pages/{page_id}/highlights"), body).await.assert_status(201);
    let got = read(&mcp, "get", json!({"page_id": page_id})).await;
    let h = &got["highlights"][0];
    assert_eq!(
        (h["quote"].as_str(), h["color"].as_str(), h["block_id"].as_str()),
        (Some("the roadmap"), Some("green"), Some(para.as_str()))
    );
    assert!(h["author"].is_string());
    let only = read(&mcp, "highlights", json!({"page_id": page_id})).await;
    assert_eq!(only["highlights"], got["highlights"]);

    // a section is that part, its heading's marker included
    let part = read(&mcp, "get", json!({"page_id": page_id, "section": "Details"})).await;
    let part_md = part["markdown"].as_str().expect("markdown");
    assert!(
        part_md.starts_with("<!-- #b-") && part_md.contains("## Details") && !part_md.contains("roadmap"),
        "{part_md}"
    );

    // one block in full: its Markdown and its JSON
    let image = id_of(&blocks(&stored)[1]);
    let one = read(&mcp, "block", json!({"page_id": page_id, "block_id": image})).await;
    assert_eq!(one["type"], "image");
    assert_eq!(one["block"]["attrs"]["widthPct"], 40);
    assert!(one["markdown"].as_str().expect("markdown").contains("![Six people at a table](/uploads/team.png)"));
    let missing =
        call_err(&mcp, "docs_read", json!({"action": "block", "page_id": page_id, "block_id": "b-ffffff"})).await;
    assert!(missing.contains("No block b-ffffff"), "{missing}");
}

#[tokio::test]
async fn block_edits_change_one_block_and_keep_the_others() {
    if !skip_unless_available("block_edits_change_one_block_and_keep_the_others") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let (_, page_id) = post_page(&c, &mcp).await;
    let before = page(&c, &page_id).await;
    let ids: Vec<String> = blocks(&before).iter().map(id_of).collect();
    let (title, image, para, quote) = (&ids[0], &ids[1], &ids[2], &ids[3]);

    // replace: the heading keeps its id and its centring; nothing else moves
    let out = write(
        &mcp,
        "edit",
        json!({"page_id": page_id, "block_id": title, "markdown": "## Why the roadmap moved", "base_version": 1}),
    )
    .await;
    assert_eq!((out["version"].as_i64(), out["published"].as_bool()), (Some(2), Some(true)));
    assert_eq!(out["changed"], json!([format!("block {title}")]));
    let now = page(&c, &page_id).await;
    let heading = by_id(&now, title).expect("the heading");
    assert_eq!(heading["attrs"]["textAlign"], "center");
    assert_eq!(heading["content"][0]["text"], "Why the roadmap moved");
    for id in [image, para, quote] {
        assert_eq!(by_id(&now, id), by_id(&before, id), "{id}");
    }

    // after, attrs and delete in one call: one version
    let out = write(
        &mcp,
        "edit",
        json!({"page_id": page_id, "items": [
            {"block_id": para, "mode": "after", "markdown": "A new paragraph with [colour]{color=teal}."},
            {"block_id": image, "mode": "attrs", "attrs": {"placement": "floatLeft", "width": null}},
            {"block_id": quote, "mode": "delete"},
        ]}),
    )
    .await;
    assert_eq!(out["version"], 3);
    let now = page(&c, &page_id).await;
    let after: Vec<String> = blocks(&now).iter().map(id_of).collect();
    assert_eq!(&after[..3], [title.clone(), image.clone(), para.clone()]);
    assert!(!after.contains(quote), "the pull quote is gone");
    let added = &blocks(&now)[3];
    assert!(!ids.contains(&id_of(added)), "a new block gets a new id");
    assert!(added.to_string().contains("teal"), "{added}");
    let picture = by_id(&now, image).expect("the picture");
    assert_eq!(picture["attrs"]["placement"], "floatLeft");
    assert!(picture["attrs"].get("widthPct").is_none(), "null clears an attribute");
    assert_eq!(picture["attrs"]["caption"], "Planning night");

    // a passage found in the annotated text keeps the block's id
    let out = write(&mcp, "edit", json!({"page_id": page_id, "find": "two years", "markdown": "three years"})).await;
    assert_eq!(out["version"], 4);
    let now = page(&c, &page_id).await;
    assert!(by_id(&now, para).expect("the paragraph").to_string().contains("three years"));
    // a section edit keeps the ids of the blocks around it
    let details =
        marker_before(read(&mcp, "get", json!({"page_id": page_id})).await["markdown"].as_str().unwrap(), "## Details");
    write(&mcp, "edit", json!({"page_id": page_id, "section": "Details", "mode": "prepend", "markdown": "First."}))
        .await;
    let now = page(&c, &page_id).await;
    assert!(by_id(&now, &details).is_some() && by_id(&now, title).is_some());

    // refusals say how to fix the call, and change nothing
    for (args, says) in [
        (json!({"block_id": "b-ffffff", "markdown": "x"}), "No block b-ffffff"),
        (json!({"block_id": para, "mode": "attrs", "attrs": {"nope": 1}}), "no attribute nope"),
        (json!({"block_id": para, "mode": "append", "markdown": "x"}), "replace, after, delete, attrs"),
        (json!({"block_id": para, "section": "Details", "markdown": "x"}), "not two of them"),
        (json!({"find": "Tickets", "attrs": {"align": "center"}, "markdown": "x"}), "attrs works with block_id"),
    ] {
        let mut arguments = json!({"action": "edit", "page_id": page_id});
        for (k, v) in args.as_object().expect("args") {
            arguments[k] = v.clone();
        }
        let refused = call_err(&mcp, "docs_write", arguments).await;
        assert!(refused.contains(says) && refused.contains("Nothing was changed"), "{says}: {refused}");
    }
    assert_eq!(page(&c, &page_id).await["version"], 5);
}

/// A rich page with a video between two paragraphs, published by a person: (page id, the three ids).
async fn page_with_a_video(c: &Client) -> (String, [String; 3]) {
    let pid = project(c).await;
    let made = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "Demo"})).await;
    let page_id = made.json()["id"].as_str().expect("an id").to_string();
    let content = json!({"type": "doc", "content": [
        {"type": "paragraph", "attrs": {"blockId": "b-0000a1"}, "content": [{"type": "text", "text": "Watch this."}]},
        {"type": "video", "attrs": {"blockId": "b-0000a2", "src": "/uploads/demo.mp4", "title": "Release demo"}},
        {"type": "paragraph", "attrs": {"blockId": "b-0000a3"}, "content": [{"type": "text", "text": "The end."}]},
    ]});
    c.put(&format!("/docs/pages/{page_id}/draft"), json!({"content": content})).await.assert_status(200);
    c.post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": 0})).await.assert_status(200);
    (page_id, ["b-0000a1".into(), "b-0000a2".into(), "b-0000a3".into()])
}

#[tokio::test]
async fn a_placeholder_is_kept_unless_it_is_deleted_on_purpose() {
    if !skip_unless_available("a_placeholder_is_kept_unless_it_is_deleted_on_purpose") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let (page_id, [first, video, last]) = page_with_a_video(&c).await;
    let got = read(&mcp, "get", json!({"page_id": page_id})).await;
    let md = got["markdown"].as_str().expect("markdown");
    assert!(md.contains(&format!("<!-- #{video} video -->\n[embed: video · Release demo]")), "{md}");
    let one = read(&mcp, "block", json!({"page_id": page_id, "block_id": video})).await;
    assert_eq!(one["block"]["attrs"]["src"], "/uploads/demo.mp4");

    // update leaves the video out: it stays where it was, and the answer says so
    let out = write(
        &mcp,
        "update",
        json!({"page_id": page_id, "base_version": 1,
               "markdown": format!("<!-- #{first} -->\nWatch this, please.\n\n<!-- #{last} -->\nThe end.\n")}),
    )
    .await;
    assert_eq!(out["kept"], json!([format!("{video} (video)")]));
    let now = page(&c, &page_id).await;
    let order: Vec<String> = blocks(&now).iter().map(id_of).collect();
    assert_eq!(&order[..3], [first.clone(), video.clone(), last.clone()]);
    assert_eq!(by_id(&now, &video).expect("the video")["attrs"]["src"], "/uploads/demo.mp4");

    // an edit that drops its lines is refused; replacing it is refused; a block delete removes it
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "edit", "page_id": page_id, "find": "[embed: video · Release demo]", "markdown": "gone"}),
    )
    .await;
    assert!(refused.contains("keep its placeholder line") && refused.contains("Nothing was changed."), "{refused}");
    let both_lines = format!("<!-- #{video} video -->\n[embed: video · Release demo]");
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "edit", "page_id": page_id, "find": both_lines, "markdown": "gone"}),
    )
    .await;
    assert!(refused.contains(&format!("block_id='{video}', mode='delete'")), "{refused}");
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "edit", "page_id": page_id, "block_id": video, "markdown": "A paragraph"}),
    )
    .await;
    assert!(refused.contains("can only be deleted"), "{refused}");
    write(&mcp, "edit", json!({"page_id": page_id, "block_id": video, "mode": "delete"})).await;
    assert!(by_id(&page(&c, &page_id).await, &video).is_none());
}

#[tokio::test]
async fn an_ai_teams_change_waits_as_suggestions_unless_the_page_applies_it() {
    if !skip_unless_available("an_ai_teams_change_waits_as_suggestions_unless_the_page_applies_it") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let (pid, page_id) = post_page(&c, &mcp).await;
    ai_team(&s, &pid).await;
    let team = s.mcp().bearer(TOKEN);
    let before = page(&c, &page_id).await;
    let ids: Vec<String> = blocks(&before).iter().map(id_of).collect();
    let (title, para) = (&ids[0], &ids[2]);

    // suggest first (the default): no new version, one suggestion per block
    let out = write(
        &team,
        "edit",
        json!({"page_id": page_id, "items": [
            {"block_id": para, "markdown": "We kept the roadmap in slides for two years."},
            {"block_id": title, "mode": "attrs", "attrs": {"align": null}},
        ]}),
    )
    .await;
    assert_eq!(out["mode"], "suggest");
    assert_eq!(out["suggestions"], 2);
    assert_eq!((out["version"].as_i64(), out["published"].as_bool()), (Some(1), Some(false)));
    assert!(out["message"].as_str().expect("message").contains("2 suggestions"), "{out}");
    assert_eq!(page(&c, &page_id).await["version"], 1);
    let waiting = c.get(&format!("/docs/pages/{page_id}/suggestions")).await.json();
    assert_eq!(waiting["count"], 2);
    let mut kinds: Vec<&str> =
        waiting["suggestions"].as_array().expect("list").iter().filter_map(|s| s["kind"].as_str()).collect();
    kinds.sort_unstable();
    assert_eq!(kinds, ["attrs", "replace"]);
    assert!(waiting["suggestions"].as_array().expect("list").iter().all(|s| s["author"] == "Docs team"));
    // the team reads what waits
    assert_eq!(read(&team, "get", json!({"page_id": page_id})).await["suggestions_waiting"], 2);

    // a block locked for teams is left as it is, and the answer says so
    exec(
        &s,
        "UPDATE docs_page SET settings = ? WHERE id = ?",
        &[json!(json!({"lockedBlocks": [para]}).to_string()), json!(page_id)],
    )
    .await;
    let out = write(&team, "edit", json!({"page_id": page_id, "block_id": para, "markdown": "Rewritten."})).await;
    assert_eq!(out["left_alone"], json!([para]));
    assert_eq!(out["suggestions"], 0);
    assert!(out["message"].as_str().expect("message").contains("locked for teams"), "{out}");

    // the page applies a team's changes directly: a new version
    exec(
        &s,
        "UPDATE docs_page SET settings = ? WHERE id = ?",
        &[json!(json!({"aiApply": "direct"}).to_string()), json!(page_id)],
    )
    .await;
    let out = write(
        &team,
        "edit",
        json!({"page_id": page_id, "find": "Tickets stay small", "markdown": "Tickets stay tiny"}),
    )
    .await;
    assert_eq!(
        (out["mode"].as_str(), out["published"].as_bool(), out["version"].as_i64()),
        (Some("direct"), Some(true), Some(2))
    );
    let now = page(&c, &page_id).await;
    assert!(now["markdown"].as_str().expect("markdown").contains("Tickets stay tiny"));
    let versions = c.get(&format!("/docs/pages/{page_id}/versions")).await.json();
    let latest = versions.as_array().and_then(|v| v.first()).cloned().unwrap_or(Value::Null);
    assert_eq!(latest["author"], "Docs team", "{versions}");
}

#[tokio::test]
async fn a_rewrite_that_would_lose_formatting_is_kept_as_a_note() {
    if !skip_unless_available("a_rewrite_that_would_lose_formatting_is_kept_as_a_note") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let (pid, page_id) = post_page(&c, &mcp).await;
    // a person gives the paragraph a colour and a link
    let ids: Vec<String> = blocks(&page(&c, &page_id).await).iter().map(id_of).collect();
    let para = ids[2].clone();
    let styled = format!(
        "<!-- #{para} -->\nWe kept the [roadmap]{{color=green}} in a [slide deck](https://example.com) for two years.\n"
    );
    let out = write(&mcp, "edit", json!({"page_id": page_id, "block_id": para, "markdown": styled})).await;
    assert_eq!(out["published"], true, "{out}");
    ai_team(&s, &pid).await;
    let team = s.mcp().bearer(TOKEN);

    // the team rewrites it in plain words: the block stays, its words are kept in a note
    let out = write(&team, "edit", json!({"page_id": page_id, "block_id": para, "markdown": "We used slides."})).await;
    assert_eq!(out["suggestions"], 0, "{out}");
    assert!(out["message"].as_str().expect("message").contains("remove their colours"), "{out}");
    let waiting = c.get(&format!("/docs/pages/{page_id}/suggestions")).await.json();
    assert_eq!(waiting["count"], 0);
    let notes = waiting["notes"].as_array().expect("notes").clone();
    assert_eq!(notes.len(), 1, "{waiting}");
    assert_eq!(
        (notes[0]["kind"].as_str(), notes[0]["block_id"].as_str(), notes[0]["author"].as_str()),
        (Some("formatting"), Some(para.as_str()), Some("Docs team"))
    );
    assert_eq!(notes[0]["wrote"], "We used slides.");
    assert_eq!(notes[0]["lost"], json!({"colour": 1, "link": 1}));

    // Replace the block: the team's words are published; the note is gone
    let note_id = notes[0]["id"].as_str().expect("id").to_string();
    let done = c.post(&format!("/docs/pages/{page_id}/suggestions/notes/{note_id}/replace"), json!({})).await;
    done.assert_status(200);
    let now = page(&c, &page_id).await;
    assert_eq!(now["version"], 3);
    assert!(now["markdown"].as_str().expect("markdown").contains("We used slides."), "{now}");
    let waiting = c.get(&format!("/docs/pages/{page_id}/suggestions")).await.json();
    assert_eq!(waiting["notes"], json!([]));

    // a locked block's note, dismissed
    exec(
        &s,
        "UPDATE docs_page SET settings = ? WHERE id = ?",
        &[json!(json!({"lockedBlocks": [para]}).to_string()), json!(page_id)],
    )
    .await;
    let out = write(&team, "edit", json!({"page_id": page_id, "block_id": para, "markdown": "Again."})).await;
    assert_eq!(out["left_alone"], json!([para]));
    let notes = c.get(&format!("/docs/pages/{page_id}/suggestions")).await.json()["notes"].clone();
    assert_eq!(notes[0]["kind"], "locked", "{notes}");
    let id = notes[0]["id"].as_str().expect("id");
    let done = c.post(&format!("/docs/pages/{page_id}/suggestions/notes/dismiss"), json!({"ids": [id]})).await;
    assert_eq!(done.json()["dismissed"], 1);
    assert_eq!(c.get(&format!("/docs/pages/{page_id}/suggestions")).await.json()["notes"], json!([]));
}

#[tokio::test]
async fn a_teams_draft_names_the_formatting_it_used() {
    if !skip_unless_available("a_teams_draft_names_the_formatting_it_used") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let (pid, page_id) = post_page(&c, &mcp).await;
    ai_team(&s, &pid).await;
    let team = s.mcp().bearer(TOKEN);
    let out =
        write(&team, "update", json!({"page_id": page_id, "markdown": POST, "base_version": 1, "publish": false}))
            .await;
    assert_eq!(out["published"], false, "{out}");
    let row = query_one(&s, "SELECT ai_source FROM docs_draft WHERE page_id = ?", &[json!(page_id)]).await;
    let source: Value = serde_json::from_str(row.as_str().expect("an ai_source")).expect("json");
    assert_eq!(source["kind"], "team");
    assert_eq!(source["member_id"], "mem_docs_team");
    assert_eq!(source["formatting"], json!(["Title centred", "Image floated right", "Pull quote"]), "{source}");
}

#[tokio::test]
async fn a_page_not_for_ai_teams_is_refused_to_a_team_only() {
    if !skip_unless_available("a_page_not_for_ai_teams_is_refused_to_a_team_only") {
        return;
    }
    let s = Server::start().await;
    let (c, mcp) = (s.client(), s.mcp());
    let (pid, page_id) = post_page(&c, &mcp).await;
    ai_team(&s, &pid).await;
    let team = s.mcp().bearer(TOKEN);
    c.patch(&format!("/docs/pages/{page_id}/settings"), json!({"settings": {"notForAi": true}}))
        .await
        .assert_status(200);
    for (tool, arguments) in [
        ("docs_read", json!({"action": "get", "page_id": page_id})),
        ("docs_read", json!({"action": "highlights", "page_id": page_id})),
        ("docs_write", json!({"action": "edit", "page_id": page_id, "find": "two years", "markdown": "ages"})),
        ("docs_write", json!({"action": "update", "page_id": page_id, "markdown": "x", "base_version": 1})),
    ] {
        let refused = call_err(&team, tool, arguments.clone()).await;
        assert!(refused.contains("Not for AI teams"), "{arguments}: {refused}");
    }
    // a person (or an agent outside a board run) still reads and writes it
    let got = read(&mcp, "get", json!({"page_id": page_id})).await;
    assert_eq!(got["version"], 1);
    write(&mcp, "edit", json!({"page_id": page_id, "find": "two years", "markdown": "ages"})).await;
    let settings: Map<String, Value> = page(&c, &page_id).await["settings"].as_object().cloned().unwrap_or_default();
    assert_eq!(settings.get("notForAi"), Some(&json!(true)));
}
