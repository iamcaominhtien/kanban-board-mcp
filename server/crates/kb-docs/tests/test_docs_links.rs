//! Links to the headings and blocks of rich pages through the HTTP API: what a link can point at, the link index by
//! block (Referenced by), resolving links by page and block id (renames, gone blocks) and search matches that name
//! their block.

mod common;

use common::{id, pid};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

fn doc(blocks: Value) -> Value {
    json!({"type": "doc", "content": blocks})
}

fn text(t: &str) -> Value {
    json!({"type": "text", "text": t})
}

fn heading(id: &str, t: &str) -> Value {
    json!({"type": "heading", "attrs": {"blockId": id, "level": 2}, "content": [text(t)]})
}

fn cell(kind: &str, t: &str) -> Value {
    json!({"type": kind, "content": [{"type": "paragraph", "content": [text(t)]}]})
}

/// The page links point at: a paragraph, a heading, a table right under it, a picture with a caption.
fn target(heading_text: &str, with_table: bool) -> Value {
    let mut blocks = vec![
        json!({"type": "paragraph", "attrs": {"blockId": "b-0000a4"}, "content": [text("Every route counts requests.")]}),
        heading("b-0000a1", heading_text),
    ];
    if with_table {
        blocks.push(json!({"type": "table", "attrs": {"blockId": "b-0000a2"}, "content": [
            {"type": "tableRow", "content": [cell("tableHeader", "Plan"), cell("tableHeader", "Burst")]},
            {"type": "tableRow", "content": [cell("tableCell", "Business"), cell("tableCell", "600")]}
        ]}));
    }
    blocks.push(json!({"type": "image", "attrs": {"blockId": "b-0000a3", "src": "/x.png", "alt": "",
        "caption": "Figure 2. Throttle hits per day"}}));
    doc(Value::Array(blocks))
}

/// Creates a page and publishes `content` as its next version; returns its id.
async fn publish(c: &Client, pid: &str, page_id: Option<&str>, title: &str, content: Value) -> String {
    let page_id = match page_id {
        Some(p) => p.to_string(),
        None => id(&c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": title})).await.json()),
    };
    let page = c.get(&format!("/docs/pages/{page_id}")).await.json();
    let base = page["version"].as_i64().unwrap_or(0);
    let r = c.put(&format!("/docs/pages/{page_id}/draft"), json!({"content": content, "base_version": base})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    let r = c.post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": base})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    page_id
}

fn doc_ref(page: &str, page_id: &str, section: Option<&str>, block: &str) -> Value {
    json!({"type": "docRef", "attrs": {"page": page, "section": section, "label": null, "pageId": page_id,
        "targetBlockId": block}})
}

#[tokio::test]
async fn links_to_headings_and_blocks_are_indexed_resolved_and_searched_by_block() {
    if !skip_unless_available("links_to_headings_and_blocks_are_indexed_resolved_and_searched_by_block") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let t = publish(&c, &pid, None, "Rate limiting", target("Limits", true)).await;
    let source = doc(json!([
        {"type": "paragraph", "attrs": {"blockId": "b-0000b1"}, "content": [
            text("We chose a window, see "), doc_ref("Rate limiting", &t, None, "b-0000a2"), text(" for the numbers.")
        ]},
        {"type": "paragraph", "attrs": {"blockId": "b-0000b2"}, "content": [
            text("Rules: "), doc_ref("Rate limiting", &t, Some("Limits"), "b-0000a1")
        ]}
    ]));
    let src = publish(&c, &pid, None, "Decision log", source).await;

    // what a link can point at, and how many pages link to each
    let targets = c.get(&format!("/docs/pages/{t}/link-targets")).await.json();
    assert_eq!(targets["headings"][0]["block_id"], "b-0000a1");
    assert_eq!(targets["headings"][0]["slug"], "limits");
    let kinds: Vec<(&str, &str)> = targets["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| (b["kind"].as_str().unwrap(), b["label"].as_str().unwrap()))
        .collect();
    assert_eq!(kinds, vec![("table", "Limits"), ("image", "Figure 2. Throttle hits per day")]);
    assert_eq!(targets["inbound"], json!({"b-0000a1": 1, "b-0000a2": 1}));
    assert_eq!(c.get("/docs/pages/nope/link-targets").await.status, 404);

    // Referenced by names the block each link sits in and the block it points at
    let back = c.get(&format!("/docs/pages/{t}/backlinks")).await.json();
    let rows = back["pages"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{back}");
    let table_row = rows.iter().find(|r| r["source_block_id"] == "b-0000b1").expect("the table link");
    assert_eq!(table_row["page_id"], json!(src));
    assert_eq!(table_row["target_block"]["kind"], "table");
    assert_eq!(table_row["target_block"]["label"], "Limits");
    assert_eq!(table_row["target_block"]["detail"], "Table · 2 columns, 2 rows");
    assert!(table_row["context"].as_str().unwrap().contains("We chose a window"));

    // a link follows its page by id and its heading when it is renamed; a gone block says so
    publish(&c, &pid, Some(&t), "Rate limiting", target("Plan limits", false)).await;
    let resolved = c
        .post(
            &format!("/projects/{pid}/docs/resolve"),
            json!({"refs": [
                {"kind": "page", "title": "An old title", "page_id": t, "block_id": "b-0000a3"},
                {"kind": "page", "title": "Rate limiting", "anchor": "Limits", "page_id": t, "block_id": "b-0000a1"},
                {"kind": "page", "title": "Rate limiting", "page_id": t, "block_id": "b-0000a2"},
                {"kind": "page", "title": "Rate limiting"}
            ]}),
        )
        .await
        .json();
    let r = resolved["results"].as_array().or_else(|| resolved.as_array()).expect("results").clone();
    assert_eq!((r[0]["status"].as_str(), r[0]["title"].as_str()), (Some("ok"), Some("Rate limiting")));
    assert_eq!(r[0]["block"]["kind"], "image");
    assert_eq!(r[1]["status"], "ok");
    assert_eq!((r[1]["section"].as_str(), r[1]["anchor"].as_str()), (Some("Plan limits"), Some("plan-limits")));
    assert_eq!((r[2]["status"].as_str(), r[2]["block_id"].as_str()), (Some("block_missing"), Some("b-0000a2")));
    assert!(r[3].get("block").is_none());

    // search reads captions and names the block of each match
    let found = c.get(&format!("/projects/{pid}/docs/search?q=throttle")).await.json();
    let m = &found["pages"][0]["matches"][0];
    assert_eq!(
        (m["block_id"].as_str(), m["kind"].as_str(), m["field"].as_str()),
        (Some("b-0000a3"), Some("image"), Some("caption"))
    );
    let found = c.get(&format!("/projects/{pid}/docs/search?q=counts")).await.json();
    assert_eq!(found["pages"][0]["matches"][0]["block_id"], "b-0000a4");
    assert_eq!(found["pages"][0]["matches"][0]["kind"], "text");
}

#[tokio::test]
async fn search_names_table_rows_counts_match_types_and_filters_by_them() {
    if !skip_unless_available("search_names_table_rows_counts_match_types_and_filters_by_them") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let t = publish(&c, &pid, None, "Rate limiting", target("Limits", true)).await;
    let notes = doc(json!([
        {"type": "paragraph", "attrs": {"blockId": "b-0000c1"}, "content": [text("Business plans renew yearly.")]}
    ]));
    let n = publish(&c, &pid, None, "Notes", notes).await;

    // a table match names its row (the header row is row 1) and carries its cells
    let found = c.get(&format!("/projects/{pid}/docs/search?q=business&facets=kinds")).await.json();
    let rate = found["pages"].as_array().unwrap().iter().find(|p| p["page_id"] == json!(t)).expect("rate").clone();
    let m = &rate["matches"][0];
    assert_eq!((m["kind"].as_str(), m["row"].as_i64()), (Some("table"), Some(2)), "{m}");
    assert_eq!(m["cells"], json!(["Business", "600"]));
    // the Type filter's counts: pages per type of match
    let kinds = &found["facets"]["kinds"];
    let count = |name: &str| kinds.as_array().unwrap().iter().find(|k| k["name"] == name).unwrap()["count"].clone();
    assert_eq!((count("page"), count("table"), count("image")), (json!(1), json!(1), json!(0)), "{kinds}");
    // without facets=kinds the facet is not counted
    let plain = c.get(&format!("/projects/{pid}/docs/search?q=business")).await.json();
    assert!(plain["facets"].get("kinds").is_none());

    // kind=table keeps the pages with a table match, and only those matches
    let tables = c.get(&format!("/projects/{pid}/docs/search?q=business&kind=table")).await.json();
    let ids: Vec<&Value> = tables["pages"].as_array().unwrap().iter().map(|p| &p["page_id"]).collect();
    assert_eq!(ids, vec![&json!(t)]);
    assert_eq!(tables["total"], 1);
    let text_only = c.get(&format!("/projects/{pid}/docs/search?q=business&kind=page")).await.json();
    let ids: Vec<&Value> = text_only["pages"].as_array().unwrap().iter().map(|p| &p["page_id"]).collect();
    assert_eq!(ids, vec![&json!(n)]);
}
