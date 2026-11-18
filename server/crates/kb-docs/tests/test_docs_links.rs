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

fn link_to(page: &str) -> Value {
    json!({"type": "docRef", "attrs": {"page": page, "section": null, "label": null, "pageId": null,
        "targetBlockId": null}})
}

fn para(id: &str, content: Value) -> Value {
    json!({"type": "paragraph", "attrs": {"blockId": id}, "content": content})
}

#[tokio::test]
async fn broken_link_groups_are_relinked_or_removed_across_pages_with_a_version_each() {
    if !skip_unless_available("broken_link_groups_are_relinked_or_removed_across_pages_with_a_version_each") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let log = publish(&c, &pid, None, "Decision log", doc(json!([para("b-0000c1", json!([text("Why.")]))]))).await;
    let a = publish(
        &c,
        &pid,
        None,
        "Overview",
        doc(json!([para("b-0000d1", json!([text("Check "), link_to("Old rules"), text(" for the older rules.")]))])),
    )
    .await;
    let b = publish(
        &c,
        &pid,
        None,
        "Planning",
        doc(json!([para(
            "b-0000e1",
            json!([text("Revisit "), link_to("Old rules"), text(" and "), link_to("Old rules")])
        )])),
    )
    .await;
    // someone has a draft of Planning on top of the published version
    let base = c.get(&format!("/docs/pages/{b}")).await.json()["version"].as_i64().unwrap();
    let draft = doc(json!([para("b-0000e1", json!([text("Draft: "), link_to("Old rules")]))]));
    let r = c.put(&format!("/docs/pages/{b}/draft"), json!({"content": draft, "base_version": base})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());

    // relink both pages' links to the Decision log
    let r = c
        .post(
            &format!("/projects/{pid}/docs/links/fix"),
            json!({"page": "Old rules", "pages": [a, b], "action": "relink", "to": {"page_id": log}}),
        )
        .await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    let out = r.json();
    assert_eq!((out["links"].as_i64(), out["pages"].as_i64()), (Some(3), Some(2)), "{out}");
    let planning = c.get(&format!("/docs/pages/{b}")).await.json();
    assert_eq!(planning["version"].as_i64(), Some(base + 1));
    let versions = c.get(&format!("/docs/pages/{b}/versions")).await.json();
    let notes = versions.to_string();
    assert!(notes.contains("Links to \\\"Old rules\\\" now point to \\\"Decision log\\\""), "{notes}");
    let content = planning["content"].to_string();
    assert!(content.contains(&log) && !content.contains("Old rules"), "{content}");
    // the draft was relinked too and moved to the new version (no false conflict)
    let draft = &planning["draft"];
    assert_eq!(draft["base_version"].as_i64(), Some(base + 1), "{planning}");
    assert!(draft["content"].to_string().contains("Decision log"), "{draft}");
    let back = c.get(&format!("/docs/pages/{log}/backlinks")).await.json();
    assert_eq!(back["pages"].as_array().map(Vec::len), Some(2), "{back}");

    // remove keeps the words
    let r = c
        .post(
            &format!("/projects/{pid}/docs/links/fix"),
            json!({"page": "Decision log", "pages": [a], "action": "remove"}),
        )
        .await;
    assert_eq!(r.json()["links"], 1);
    let overview = c.get(&format!("/docs/pages/{a}")).await.json();
    assert_eq!(overview["content"]["content"][0]["content"], json!([text("Check Decision log for the older rules.")]));

    // what the route refuses
    let bad =
        c.post(&format!("/projects/{pid}/docs/links/fix"), json!({"page": "X", "pages": [a], "action": "zap"})).await;
    assert_eq!((bad.status, bad.json()["detail"]["code"].as_str()), (422, Some("invalid_action")));
    let bad = c
        .post(&format!("/projects/{pid}/docs/links/fix"), json!({"page": "X", "pages": [a], "action": "relink"}))
        .await;
    assert_eq!(bad.status, 422);
    let bad = c
        .post(&format!("/projects/{pid}/docs/links/fix"), json!({"page": "X", "pages": ["nope"], "action": "remove"}))
        .await;
    assert_eq!(bad.status, 404);
}

#[tokio::test]
async fn rename_lists_plain_text_mentions_and_changes_only_the_chosen_ones() {
    if !skip_unless_available("rename_lists_plain_text_mentions_and_changes_only_the_chosen_ones") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let t = publish(&c, &pid, None, "Rate limiting", doc(json!([para("b-0000f1", json!([text("Limits.")]))]))).await;
    let notes = publish(
        &c,
        &pid,
        None,
        "Release notes",
        doc(json!([
            para("b-0000f2", json!([text("The new Rate limiting headers ship on Friday.")])),
            para("b-0000f3", json!([text("We start rate limiting with free plans.")])),
            para("b-0000f4", json!([text("See "), link_to("Rate limiting")])),
        ])),
    )
    .await;
    let plain = c.get(&format!("/docs/pages/{t}/rename-preview?title=Request%20limits")).await.json();
    assert!(plain.get("mentions").is_none(), "opt-in only: {plain}");
    let preview = c.get(&format!("/docs/pages/{t}/rename-preview?title=Request%20limits&mentions=true")).await.json();
    assert_eq!(preview["total"], 1);
    let m = preview["mentions"].as_array().expect("mentions").clone();
    assert_eq!(m.len(), 2, "{preview}");
    assert_eq!((m[0]["block_id"].as_str(), m[0]["text"].as_str()), (Some("b-0000f2"), Some("Rate limiting")));
    assert_eq!((m[0]["before"].as_str(), m[0]["after"].as_str()), (Some("The new "), Some(" headers ship on Friday.")));
    assert_eq!(m[0]["page_id"], json!(notes));

    let r = c
        .patch(
            &format!("/docs/pages/{t}"),
            json!({"title": "Request limits", "rewrite_links": true,
                   "rewrite_mentions": [{"page_id": notes, "block_id": "b-0000f2"}]}),
        )
        .await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    assert_eq!((r.json()["mentions_changed"].as_i64(), r.json()["mention_pages"].as_i64()), (Some(1), Some(1)));
    let page = c.get(&format!("/docs/pages/{notes}")).await.json();
    let blocks = &page["content"]["content"];
    assert_eq!(blocks[0]["content"][0]["text"], "The new Request limits headers ship on Friday.");
    assert_eq!(blocks[1]["content"][0]["text"], "We start rate limiting with free plans.", "not chosen");
    assert_eq!(blocks[2]["content"][1]["attrs"]["page"], "Request limits");
    // a rename without the field answers as before
    let r = c.patch(&format!("/docs/pages/{t}"), json!({"title": "Limits"})).await.json();
    assert!(r.get("mentions_changed").is_none());
}

#[tokio::test]
async fn search_page_cards_outdated_filter_and_project_counts() {
    if !skip_unless_available("search_page_cards_outdated_filter_and_project_counts") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let code = json!({"type": "codeBlock", "attrs": {"blockId": "b-0000b9", "language": "http"},
        "content": [text("GET /x\n# throttle answers 429\nHTTP/1.1 429")]});
    let p = publish(&c, &pid, None, "API", doc(json!([code]))).await;
    let img = publish(&c, &pid, None, "Figures", target("Limits", false)).await;
    let found =
        c.get(&format!("/projects/{pid}/docs/search?q=throttle&cards=true&facets=outdated,projects")).await.json();
    let pages = found["pages"].as_array().unwrap();
    let api = pages.iter().find(|x| x["page_id"] == json!(p)).expect("API");
    let card = &api["matches"][0]["card"];
    assert_eq!(card["language"], "http");
    assert_eq!(card["lines"], json!([{"n": 2, "text": "# throttle answers 429"}, {"n": 3, "text": "HTTP/1.1 429"}]));
    assert_eq!(card["detail"], "Code · http", "{card}");
    let fig = pages.iter().find(|x| x["page_id"] == json!(img)).expect("Figures");
    let m = fig["matches"].as_array().unwrap().iter().find(|m| m["kind"] == "image").expect("image").clone();
    assert_eq!(m["card"]["src"], "/x.png");
    assert_eq!(m["card"]["caption"], "Figure 2. Throttle hits per day");
    assert_eq!(found["facets"]["outdated"], 0);
    assert_eq!(found["facets"]["projects"][0]["count"], 2);
    assert_eq!(found["facets"]["projects"][0]["project_id"], json!(pid));
    // without the flags the answer is as before
    let plain = c.get(&format!("/projects/{pid}/docs/search?q=throttle")).await.json();
    assert!(plain["pages"][0]["matches"][0].get("card").is_none());
    assert!(plain["facets"].get("outdated").is_none() && plain["facets"].get("projects").is_none());

    // a page marked Outdated in its settings is what status=outdated finds
    let r = c.patch(&format!("/docs/pages/{p}/settings"), json!({"settings": {"status": "outdated"}})).await;
    assert_eq!(r.status, 200, "{:?}", r.json());
    let found = c.get(&format!("/projects/{pid}/docs/search?q=throttle&status=outdated&facets=outdated")).await.json();
    assert_eq!(found["total"], 1, "{found}");
    assert_eq!(found["pages"][0]["page_id"], json!(p));
    assert_eq!(found["facets"]["outdated"], 1);
}

#[tokio::test]
async fn ticket_linked_docs_name_the_heading_or_block_of_rich_pages() {
    if !skip_unless_available("ticket_linked_docs_name_the_heading_or_block_of_rich_pages") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let t = publish(&c, &pid, None, "Rate limiting", target("Limits", true)).await;
    let ticket = common::new_ticket(
        &c,
        &pid,
        json!({"title": "Limits", "description": "Use the numbers in [[Rate limiting#Limits]]."}),
    )
    .await;
    let key = ticket["key"].as_str().or_else(|| ticket["id"].as_str()).unwrap().to_string();
    let tid = ticket["id"].as_str().unwrap().to_string();
    let src = publish(
        &c,
        &pid,
        None,
        "Rollout",
        doc(json!([
            heading("b-0000c1", "Checklist"),
            para(
                "b-0000c2",
                json!([text("Enforce on public endpoints "), {"type": "ticketRef", "attrs": {"key": key}}])
            )
        ])),
    )
    .await;
    let plain = c.get(&format!("/tickets/{tid}/docs")).await.json();
    assert!(plain.as_array().unwrap().iter().all(|r| r.get("block").is_none()), "{plain}");
    let rows = c.get(&format!("/tickets/{tid}/docs?blocks=true")).await.json();
    let rows = rows.as_array().expect("rows").clone();
    let mention = rows.iter().find(|r| r["origin"] == "description").expect("the description names the page");
    assert_eq!(mention["block_id"], "b-0000a1");
    assert_eq!(mention["block"]["kind"], "heading");
    assert_eq!(mention["excerpt"], "Plan, Burst · Business, 600 · Figure 2. Throttle hits per day", "{mention}");
    let from_page = rows.iter().find(|r| r["origin"] == "page").expect("the page names the ticket");
    assert_eq!(from_page["page_id"], json!(src));
    assert_eq!(from_page["block_id"], "b-0000c2");

    // a doc linked by hand at a block
    let other = publish(&c, &pid, None, "Decision log", doc(json!([para("b-0000c3", json!([text("Why.")]))]))).await;
    let r = c.post(&format!("/tickets/{tid}/docs"), json!({"page_id": other, "block_id": "b-0000c3"})).await;
    assert_eq!(r.status, 201, "{:?}", r.json());
    assert_eq!(r.json()["block_id"], "b-0000c3");
    assert_eq!(r.json()["excerpt"], "Why.");
    let bad = c.post(&format!("/tickets/{tid}/docs"), json!({"page_id": t, "block_id": "b-ffffff"})).await;
    assert_eq!(bad.status, 422);
}
