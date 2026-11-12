//! Two scenarios on the server, each followed by a dump of the tables it touches, normalized (page ids by slug, ids of
//! other rows and times replaced, rows sorted), which must be what the Python server stored. The expected dumps are
//! recorded from the Python server:
//!
//! - the first one (create a tree, edit, publish, move, link, bin and restore): the `docs_*` tables, in
//!   `contract/golden/docs_scenario.json`;
//! - the second one (comments: a thread, a reply, a mention, the page edited so anchors move and one is orphaned, a
//!   re-attach, resolve and reopen, an edit, deletes, a purge, an access request, then the import of a folder with
//!   conflicts, published and announced): the `docs_*` tables and the notification tables the comment events wrote, in
//!   `contract/golden/docs_scenario_comments.json`.
//!
//! `DOCS_SCENARIO_RECORD=1 PARITY_TARGET=python cargo test -p kb-docs --test docs_scenario`

mod common;

use std::collections::HashMap;

use common::{id, member, mk, new_ticket, pid, publish};
use regex::Regex;
use serde_json::{Map, Value, json};
use testkit::{Server, skip_unless_available, target};

fn canonical(dump: &Value, names: &HashMap<String, String>, keep: &dyn Fn(&str) -> bool) -> Value {
    let uuid = Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").expect("pattern");
    let time = Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?").expect("pattern");
    let tidy = |text: &str| -> String {
        let mut out = text.to_string();
        for (id, name) in names {
            out = out.replace(id.as_str(), name);
        }
        let out = time.replace_all(&out, "<time>").into_owned();
        uuid.replace_all(&out, "<uuid>").into_owned()
    };
    let mut tables = Map::new();
    for (table, rows) in dump.as_object().expect("dump") {
        // `docs_fts` is the search index itself; its shadow tables (`docs_fts_content`...) hold row numbers of the engine
        if !keep(table) || table.starts_with("docs_fts_") {
            continue;
        }
        let mut rows: Vec<Value> = rows
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| {
                let mut out = Map::new();
                for (column, value) in row.as_object().expect("row") {
                    let value = match value {
                        // the row's own id (random) is not compared; a page's id is its slug
                        Value::String(s) if column == "id" && table != "docs_page" => json!("<id>"),
                        Value::String(s) => json!(tidy(s)),
                        other => other.clone(),
                    };
                    out.insert(column.clone(), value);
                }
                Value::Object(out)
            })
            .collect();
        rows.sort_by_key(|r| r.to_string());
        tables.insert(table.clone(), Value::Array(rows));
    }
    Value::Object(tables)
}

#[tokio::test]
async fn the_docs_tables_hold_the_same_after_one_scenario() {
    if !skip_unless_available("the_docs_tables_hold_the_same_after_one_scenario") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    member(&c, &pid, "Mia", "member").await;
    let mia = c.clone().header("x-actor", "Mia");
    let t1 = new_ticket(&c, &pid, json!({"title": "Plan the work", "description": "see [[Plan#Goals]]"})).await;
    let key = id(&t1);

    let plan =
        publish(&c, &mk(&c, &pid, "Plan", json!({})).await, "## Goals\nship\n## Risks\nnone", Some("first")).await;
    let spec = mk(&c, &pid, "Spec", json!({"parent_id": plan["id"]})).await;
    let spec = publish(
        &c,
        &spec,
        &format!("## Design\nsee [[Plan#Goals]] and [[Plan#Risks|risks]] and {key} and [[Ghost]]"),
        None,
    )
    .await;
    let notes = mk(&c, &pid, "Notes", json!({"markdown": "draft with [[Spec]]"})).await;
    let archive = publish(&c, &mk(&c, &pid, "Archive", json!({})).await, "old", None).await;
    // a heading rename keeps an alias, a second version, a rename that rewrites links
    publish(&c, &plan, "## Aims\nship\n## Risks\nnone", Some("renamed a heading")).await;
    c.patch(&format!("/docs/pages/{}", id(&plan)), json!({"title": "Roadmap", "rewrite_links": true}))
        .await
        .assert_status(200);
    c.post(&format!("/tickets/{key}/docs"), json!({"page_id": archive["id"]})).await.assert_status(201);
    c.post(&format!("/docs/pages/{}/move", id(&notes)), json!({"parent_id": spec["id"]})).await.assert_status(200);
    c.post(&format!("/docs/pages/{}/move", id(&archive)), json!({"parent_id": null, "before_id": plan["id"]}))
        .await
        .assert_status(200);
    c.post(&format!("/docs/pages/{}/duplicate", id(&plan)), json!({"include_children": true})).await.assert_status(201);
    c.put(&format!("/projects/{pid}/docs/follow"), json!({"on": true})).await.assert_status(200);
    mia.put(&format!("/docs/pages/{}/seen", id(&plan)), json!({"version": 2})).await.assert_status(200);
    mia.put(&format!("/docs/pages/{}/draft", id(&plan)), json!({"markdown": "mia's draft", "title": "Mia's title"}))
        .await
        .assert_status(200);
    // the bin: delete a subtree, restore it, delete a leaf and purge it, leave a page in the bin
    c.delete(&format!("/docs/pages/{}", id(&spec))).await.assert_status(200);
    c.post_empty(&format!("/docs/pages/{}/restore", id(&spec))).await.assert_status(200);
    c.delete(&format!("/docs/pages/{}", id(&notes))).await.assert_status(200);
    c.delete(&format!("/docs/pages/{}/purge", id(&notes))).await.assert_status(204);
    c.post(&format!("/docs/pages/{}/versions/1/restore", id(&plan)), json!({"notify": false})).await.assert_status(200);
    c.delete(&format!("/docs/pages/{}", id(&archive))).await.assert_status(200);
    c.delete(&format!("/tickets/{key}/docs/{}", id(&archive))).await.assert_status(200);

    let mut names: HashMap<String, String> = HashMap::new();
    names.insert(pid.clone(), "<project>".into());
    for row in c.get(&format!("/projects/{pid}/docs/tree")).await.json().as_array().expect("tree") {
        names.insert(id(row), format!("<page:{}>", row["slug"].as_str().expect("slug")));
    }
    for row in c.get(&format!("/projects/{pid}/docs/recycle-bin")).await.json().as_array().expect("bin") {
        names.insert(id(row), format!("<page:{}>", row["title"].as_str().expect("title").to_lowercase()));
    }
    for page in [&plan, &spec, &notes, &archive] {
        names.entry(id(page)).or_insert_with(|| format!("<page:{}>", page["slug"].as_str().expect("slug")));
    }
    let got = canonical(&s.dump_db().await, &names, &|t| t.starts_with("docs_"));

    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract/golden/docs_scenario.json");
    if std::env::var("DOCS_SCENARIO_RECORD").is_ok_and(|v| v == "1") {
        assert_eq!(format!("{:?}", target()), "Python", "record from the Python server");
        std::fs::write(&path, serde_json::to_string_pretty(&got).expect("json") + "\n").expect("write the golden file");
        return;
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("golden file")).expect("golden json");
    for (table, rows) in want.as_object().expect("tables") {
        assert_eq!(got[table], *rows, "table {table}");
    }
    assert_eq!(
        got.as_object().expect("tables").keys().collect::<Vec<_>>(),
        want.as_object().expect("tables").keys().collect::<Vec<_>>()
    );
}

/// The comment events reach the notification centre within a second (its loop writes them): wait between the steps so
/// that each is written on its own and the rows are the same on both servers.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
}

#[tokio::test]
async fn the_docs_and_notification_tables_hold_the_same_after_comments_and_an_import() {
    if !skip_unless_available("the_docs_and_notification_tables_hold_the_same_after_comments_and_an_import") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    for (name, role) in [("Mia", "member"), ("Ada", "admin"), ("Vera", "viewer"), ("Hoa", "member")] {
        member(&c, &pid, name, role).await;
    }
    let as_ = |who: &str| c.clone().header("x-actor", who);
    let doc = "# API\n\nEvery route requires a bearer token; rotation rules live in [[Auth]].\n\n## Limits\n\nRate limits are not enforced yet. Tracked in KAN-12.\n\n## Notes\n\nA closing paragraph.\n";
    let api = publish(&c, &mk(&c, &pid, "API", json!({})).await, doc, Some("first")).await;
    let other = publish(&c, &mk(&c, &pid, "Other", json!({})).await, "## Side\ntext about something\n", None).await;
    let list = format!("/docs/pages/{}/comments", id(&api));
    let anchor = |quote: &str, section: &str| json!({"quote": quote, "prefix": "Every route requires a ", "suffix": "; rotation", "section": section});

    // threads and replies: a mention, a reply that mentions, a page comment
    let t1 = as_("Mia")
        .post(
            &list,
            json!({"kind": "inline", "body": "Is this enough? cc @Ada", "anchor": anchor("bearer token", "api")}),
        )
        .await
        .json();
    settle().await;
    let tid = id(&t1);
    as_("Ada")
        .post(&format!("/docs/comments/threads/{tid}/replies"), json!({"body": "Yes, @Mia"}))
        .await
        .assert_status(201);
    settle().await;
    let t2 = as_("Hoa")
        .post(
            &list,
            json!({"kind": "inline", "body": "Not enforced?", "anchor": {"quote": "Rate limits are not enforced"}}),
        )
        .await
        .json();
    let t3 = c
        .post(
            &list,
            json!({"kind": "inline", "body": "A link", "anchor": {"quote": "Tracked in KAN-12", "section": "limits"}}),
        )
        .await
        .json();
    settle().await;
    c.post(&list, json!({"kind": "page", "body": "Looks good [x](diagram:dg_1) @[Ada](member:none)"}))
        .await
        .assert_status(201);
    settle().await;
    as_("Mia").post_empty(&format!("/docs/comments/threads/{tid}/read")).await.assert_status(200);
    as_("Vera")
        .post(&format!("/docs/comments/threads/{tid}/replies"), json!({"body": "viewer"}))
        .await
        .assert_status(403);

    // the page is edited: one anchor moves, one changes a little, one is orphaned
    let edited = "# API\n\nIntro paragraph added above.\n\nEvery route requires a bearer token; rotation rules live in [[Auth]].\n\n## Limits\n\nRate limits are not yet enforced. Nothing else.\n";
    publish(&c, &api, edited, Some("edit")).await;
    let preview = c.post(&format!("{list}/anchor-preview"), json!({"markdown": "# API\n\nNothing.\n"})).await;
    preview.assert_status(200);

    // re-attach the orphan, resolve, reopen, edit and delete comments
    as_("Mia")
        .post(
            &format!("/docs/comments/threads/{}/reattach", id(&t3)),
            json!({"quote": "Intro paragraph", "prefix": "", "suffix": " added", "section": "api"}),
        )
        .await
        .assert_status(200);
    as_("Ada").post_empty(&format!("/docs/comments/threads/{tid}/resolve")).await.assert_status(200);
    settle().await;
    as_("Mia").post_empty(&format!("/docs/comments/threads/{tid}/reopen")).await.assert_status(200);
    settle().await;
    let listed = c.get(&list).await.json();
    let thread1 = listed["threads"].as_array().unwrap().iter().find(|t| t["id"] == tid.as_str()).unwrap().clone();
    let reply = id(&thread1["comments"][1]);
    as_("Ada")
        .patch(&format!("/docs/comments/{reply}"), json!({"body": "Yes, @Mia and @Hoa"}))
        .await
        .assert_status(200);
    as_("Ada").delete(&format!("/docs/comments/{reply}")).await.assert_status(200);
    c.delete(&format!("/docs/comments/{}", id(&t2["comments"][0]))).await.assert_status(200);
    // a page with comments is erased: its threads, comments and events go with it
    let doomed = publish(&c, &mk(&c, &pid, "Doomed", json!({})).await, "## Gone\nwords to quote here\n", None).await;
    as_("Mia")
        .post(
            &format!("/docs/pages/{}/comments", id(&doomed)),
            json!({"kind": "inline", "body": "@Ada bye", "anchor": {"quote": "words to quote"}}),
        )
        .await
        .assert_status(201);
    settle().await;
    c.delete(&format!("/docs/pages/{}", id(&doomed))).await.assert_status(200);
    c.delete(&format!("/docs/pages/{}/purge", id(&doomed))).await.assert_status(204);
    // an access request
    as_("Stranger")
        .post(&format!("/projects/{pid}/docs/access-requests"), json!({"note": "let me in"}))
        .await
        .assert_status(201);
    settle().await;

    // an import of a folder with conflicts, published and announced, then the pass that indexes the links
    let files: Vec<(&str, &[u8])> = vec![
        ("API.md", b"# API\nduplicate of an existing page"),
        ("guide/index.md", b"---\ntitle: Guide home\n---\nwelcome [[API#Limits]]"),
        ("guide/setup.md", b"# Setup\nSee [[Other]] and [[Nowhere]]."),
        ("guide/deep/more.markdown", b"more [[Setup]]"),
        ("Other.md", b"# Other\nclash"),
        ("bad.md", b"---\nx: [unclosed\n---\nz"),
    ];
    let r = common::import(&c, &pid, &files, &[("publish", "true"), ("notify", "true"), ("on_conflict", "copy")]).await;
    r.assert_status(200);
    let ids: Vec<Value> = r.json()["created"].as_array().unwrap().iter().map(|x| x["page_id"].clone()).collect();
    let r = common::import(&c, &pid, &files, &[("on_conflict", "skip")]).await;
    r.assert_status(200);
    c.post(&format!("/projects/{pid}/docs/import/resolve"), json!({"page_ids": ids})).await.assert_status(200);
    settle().await;

    let mut names: HashMap<String, String> = HashMap::new();
    names.insert(pid.clone(), "<project>".into());
    for row in c.get(&format!("/projects/{pid}/docs/tree")).await.json().as_array().expect("tree") {
        names.insert(id(row), format!("<page:{}>", row["slug"].as_str().expect("slug")));
    }
    for page in [&api, &other, &doomed] {
        names.entry(id(page)).or_insert_with(|| format!("<page:{}>", page["slug"].as_str().expect("slug")));
    }
    let keep = |t: &str| t.starts_with("docs_") || t == "notification" || t == "notify_event" || t == "notify_follow";
    let got = canonical(&s.dump_db().await, &names, &keep);

    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract/golden/docs_scenario_comments.json");
    if std::env::var("DOCS_SCENARIO_RECORD").is_ok_and(|v| v == "1") {
        assert_eq!(format!("{:?}", target()), "Python", "record from the Python server");
        std::fs::write(&path, serde_json::to_string_pretty(&got).expect("json") + "\n").expect("write the golden file");
        return;
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("golden file")).expect("golden json");
    for (table, rows) in want.as_object().expect("tables") {
        assert_eq!(got[table], *rows, "table {table}");
    }
    assert_eq!(
        got.as_object().expect("tables").keys().collect::<Vec<_>>(),
        want.as_object().expect("tables").keys().collect::<Vec<_>>()
    );
}
