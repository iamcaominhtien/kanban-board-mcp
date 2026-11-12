//! One scenario on the server (create a tree, edit, publish, move, link, bin and restore), then a dump of the `docs_*`
//! tables, normalized (page ids by slug, ids of other rows and times replaced, rows sorted), which must be what the
//! Python server stored. The expected dump is recorded from the Python server in `contract/golden/docs_scenario.json`:
//!
//! `DOCS_SCENARIO_RECORD=1 PARITY_TARGET=python cargo test -p kb-docs --test docs_scenario`

mod common;

use std::collections::HashMap;

use common::{id, member, mk, new_ticket, pid, publish};
use regex::Regex;
use serde_json::{Map, Value, json};
use testkit::{Server, skip_unless_available, target};

fn canonical(dump: &Value, names: &HashMap<String, String>) -> Value {
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
        if !table.starts_with("docs_") || table.starts_with("docs_fts_") {
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
    let got = canonical(&s.dump_db().await, &names);

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
