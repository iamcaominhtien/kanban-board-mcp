//! `tests/test_docs_search.py`: FTS5 ranking, query syntax, scopes, filters, facets, snippets. The tests that switch
//! FTS5 off by monkeypatching (`test_fallback_*`, `test_index_writes_are_noops_*`) call the service in this process:
//! `docs_search_service.rs`. `test_ensure_fts_creates_the_table_lazily_and_backfills` drops the table in the server's
//! own SQLite file and so runs here, against both servers.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{exec, id, mk, new_ticket, pid, project, publish};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

macro_rules! setup {
    ($name:expr) => {{
        if !skip_unless_available($name) {
            return;
        }
        let s = Server::start().await;
        let c = s.client();
        let pid = pid(&c).await;
        (s, c, pid)
    }};
}

/// `search(c, pid, q, **params)`: the reply of the search route, which must be a 200.
async fn search(c: &Client, pid: &str, q: &str, params: &[(&str, &str)]) -> Value {
    let mut query = vec![("q", q)];
    query.extend_from_slice(params);
    let r = c.get_query(&format!("/projects/{pid}/docs/search"), &query).await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

fn titles(result: &Value) -> Vec<String> {
    result["pages"].as_array().unwrap().iter().map(|p| p["title"].as_str().unwrap().to_string()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// The `corpus` fixture: four published pages.
async fn corpus(c: &Client, pid: &str) -> BTreeMap<&'static str, Value> {
    let mut pages = BTreeMap::new();
    pages.insert(
        "title",
        publish(c, &mk(c, pid, "Rate limiting", json!({})).await, "## Intro\nunrelated words", None).await,
    );
    pages.insert(
        "heading",
        publish(c, &mk(c, pid, "Guide", json!({})).await, "## Rate limiting\nsome text here", None).await,
    );
    pages.insert(
        "body",
        publish(c, &mk(c, pid, "Notes", json!({})).await, "## Misc\nwe apply rate limiting to every call", None).await,
    );
    pages.insert(
        "other",
        publish(c, &mk(c, pid, "Auth", json!({})).await, "## Tokens\nbearer tokens expire hourly", None).await,
    );
    pages
}

// --- ranking and syntax ------------------------------------------------------

#[tokio::test]
async fn test_title_beats_heading_beats_body() {
    let (_s, c, pid) = setup!("test_title_beats_heading_beats_body");
    corpus(&c, &pid).await;
    let res = search(&c, &pid, "rate limiting", &[]).await;
    assert_eq!(titles(&res), ["Rate limiting", "Guide", "Notes"]);
    assert!(res["total"] == 3 && res["took_ms"].as_i64().unwrap() >= 0 && res["suggestion"].is_null());
    let first = &res["pages"][0];
    for key in [
        "page_id",
        "project_id",
        "project_name",
        "title",
        "path",
        "status",
        "version",
        "updated_at",
        "updated_by",
        "matches",
    ] {
        assert!(first.get(key).is_some(), "{key}");
    }
    assert!(first["project_name"] == "Kanban" && first["status"] == "published" && first["version"] == 1);
}

#[tokio::test]
async fn test_words_are_anded_phrases_must_match_as_written_and_minus_excludes() {
    let (_s, c, pid) = setup!("test_words_are_anded_phrases_must_match_as_written_and_minus_excludes");
    corpus(&c, &pid).await;
    assert!(titles(&search(&c, &pid, "rate tokens", &[]).await).is_empty());
    assert_eq!(titles(&search(&c, &pid, "bearer tokens", &[]).await), ["Auth"]);
    assert_eq!(sorted(titles(&search(&c, &pid, "\"rate limiting\"", &[]).await)), ["Guide", "Notes", "Rate limiting"]);
    assert!(titles(&search(&c, &pid, "\"limiting rate\"", &[]).await).is_empty());
    assert_eq!(sorted(titles(&search(&c, &pid, "limiting -unrelated", &[]).await)), ["Guide", "Notes"]);
    assert_eq!(titles(&search(&c, &pid, "rate -\"every call\" -unrelated", &[]).await), ["Guide"]);
    assert!(titles(&search(&c, &pid, "-rate", &[]).await).is_empty()); // nothing positive to look for
    assert_eq!(search(&c, &pid, "", &[]).await["total"], 0);
}

#[tokio::test]
async fn test_prefix_and_case_and_diacritics() {
    let (_s, c, pid) = setup!("test_prefix_and_case_and_diacritics");
    publish(&c, &mk(&c, &pid, "Café menu", json!({})).await, "## Déjà vu\nauthentication flows", None).await;
    assert_eq!(titles(&search(&c, &pid, "AUTHEN", &[]).await), ["Café menu"]);
    assert_eq!(titles(&search(&c, &pid, "cafe", &[]).await), ["Café menu"]);
}

#[tokio::test]
async fn test_mode_headings_only_looks_at_headings() {
    let (_s, c, pid) = setup!("test_mode_headings_only_looks_at_headings");
    corpus(&c, &pid).await;
    let res = search(&c, &pid, "#rate", &[("mode", "headings")]).await;
    assert_eq!(titles(&res), ["Guide"]);
    assert_eq!(res["pages"][0]["matches"][0]["section"], "Rate limiting");
    assert_eq!(titles(&search(&c, &pid, "tokens", &[("mode", "headings")]).await), ["Auth"]); // a heading too
    assert!(titles(&search(&c, &pid, "bearer", &[("mode", "headings")]).await).is_empty()); // body only
}

#[tokio::test]
async fn test_snippets_are_marked_and_html_escaped() {
    let (_s, c, pid) = setup!("test_snippets_are_marked_and_html_escaped");
    publish(
        &c,
        &mk(&c, &pid, "XSS", json!({})).await,
        "## Part\nuse <script>alert(1)</script> to rate things & more",
        None,
    )
    .await;
    let res = search(&c, &pid, "rate", &[]).await;
    let m = &res["pages"][0]["matches"][0];
    assert!(m["section"] == "Part" && m["slug"] == "part");
    let snippet = m["snippet"].as_str().unwrap();
    assert!(snippet.contains("<mark>rate</mark>"));
    assert!(snippet.contains("&lt;script&gt;") && !snippet.contains("<script>") && snippet.contains("&amp;"));
    assert_eq!(res["pages"][0]["title_snippet"], "XSS");
    let t = search(&c, &pid, "xss", &[]).await;
    assert_eq!(t["pages"][0]["title_snippet"], "<mark>XSS</mark>");
}

#[tokio::test]
async fn test_odd_characters_never_break_the_query() {
    let (_s, c, pid) = setup!("test_odd_characters_never_break_the_query");
    corpus(&c, &pid).await;
    let long_minus = "-".repeat(50);
    let long_a = "a".repeat(400);
    let nasty = [
        "\"",
        "\"\"",
        "\"unterminated",
        "*",
        "(",
        ")",
        "a AND",
        "OR",
        "NOT",
        "NEAR(a b)",
        "title:rate",
        "rate:",
        "-",
        "--",
        "- -",
        "'; DROP TABLE docs_page; --",
        "^rate",
        "rate*",
        "{a b}:c",
        "%",
        "_",
        "\\",
        "\x00",
        "rate\x00limiting",
        "😀",
        "((((",
        "))))",
        "\"a\" \"b\" \"c\"",
        &long_minus,
        &long_a,
    ];
    for q in nasty {
        let r = c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", q)]).await;
        assert_eq!(r.status, 200, "{q}");
        assert!(r.json()["pages"].is_array());
    }
    // and the pages are still there afterwards
    assert_eq!(c.get(&format!("/projects/{pid}/docs/tree")).await.json().as_array().unwrap().len(), 4);
    // punctuation is dropped
    assert_eq!(titles(&search(&c, &pid, "rate*", &[]).await), ["Rate limiting", "Guide", "Notes"]);
}

#[tokio::test]
async fn test_phrase_with_punctuation_and_hyphenated_words() {
    let (_s, c, pid) = setup!("test_phrase_with_punctuation_and_hyphenated_words");
    publish(&c, &mk(&c, &pid, "Config", json!({})).await, "## Keys\nset max-retries to 3 and e-mail on", None).await;
    assert_eq!(titles(&search(&c, &pid, "max-retries", &[]).await), ["Config"]);
    assert_eq!(titles(&search(&c, &pid, "\"max retries\"", &[]).await), ["Config"]);
    assert_eq!(titles(&search(&c, &pid, "e-mail", &[]).await), ["Config"]);
}

// --- scopes ------------------------------------------------------------------

#[tokio::test]
async fn test_scopes_space_all_and_tickets() {
    let (_s, c, pid) = setup!("test_scopes_space_all_and_tickets");
    corpus(&c, &pid).await;
    let other = project(&c, "Other board", "OTH").await;
    publish(&c, &mk(&c, &id(&other), "Other limits", json!({})).await, "## X\nrate limiting elsewhere", None).await;
    new_ticket(&c, &pid, json!({"title": "Fix rate limiting bug", "description": "the limiter breaks"})).await;
    new_ticket(&c, &id(&other), json!({"title": "Rate card", "description": "pricing"})).await;

    let space = search(&c, &pid, "rate limiting", &[]).await;
    assert!(!titles(&space).contains(&"Other limits".to_string()));
    let tt: Vec<&Value> = space["tickets"].as_array().unwrap().iter().map(|t| &t["title"]).collect();
    assert_eq!(tt, [&json!("Fix rate limiting bug")]);
    assert!(space["tickets"][0]["ticket_id"] == "KAN-1" && space["tickets"][0]["status"] == "backlog");
    assert!(space["tickets"][0]["snippet"].as_str().unwrap().contains("<mark>rate</mark>"));

    let everywhere = search(&c, &pid, "rate limiting", &[("scope", "all")]).await;
    assert!(titles(&everywhere).contains(&"Other limits".to_string()));
    let names: BTreeSet<&str> =
        everywhere["pages"].as_array().unwrap().iter().map(|p| p["project_name"].as_str().unwrap()).collect();
    assert_eq!(names, BTreeSet::from(["Kanban", "Other board"]));
    assert_eq!(everywhere["total"], 4);

    let tickets = search(&c, &pid, "rate", &[("scope", "tickets")]).await;
    assert!(tickets["pages"] == json!([]) && tickets["total"] == 1);
    let keys = |v: &Value| -> Vec<String> {
        v["tickets"].as_array().unwrap().iter().map(|t| t["ticket_id"].as_str().unwrap().to_string()).collect()
    };
    assert_eq!(keys(&tickets), ["KAN-1"]);
    let all_tickets = search(&c, &pid, "rate", &[("scope", "all")]).await;
    assert_eq!(
        keys(&all_tickets).into_iter().collect::<BTreeSet<_>>(),
        BTreeSet::from(["KAN-1".to_string(), "OTH-1".to_string()])
    );
    assert_eq!(search(&c, &pid, "KAN-1", &[("scope", "tickets")]).await["total"], 1); // by key
    let bad = c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", "x"), ("scope", "galaxy")]).await;
    assert!(bad.status == 422 && bad.json()["detail"]["code"] == "bad_scope");
}

#[tokio::test]
async fn test_deleted_pages_leave_the_index_and_return_on_restore() {
    let (_s, c, pid) = setup!("test_deleted_pages_leave_the_index_and_return_on_restore");
    let pages = corpus(&c, &pid).await;
    let first = id(&pages["title"]);
    c.delete(&format!("/docs/pages/{first}")).await;
    assert!(!titles(&search(&c, &pid, "rate limiting", &[]).await).contains(&"Rate limiting".to_string()));
    c.post_empty(&format!("/docs/pages/{first}/restore")).await;
    assert_eq!(titles(&search(&c, &pid, "rate limiting", &[]).await)[0], "Rate limiting");
    c.delete(&format!("/docs/pages/{first}")).await;
    c.delete(&format!("/docs/pages/{first}/purge")).await;
    assert!(!titles(&search(&c, &pid, "rate limiting", &[]).await).contains(&"Rate limiting".to_string()));
}

#[tokio::test]
async fn test_index_follows_publish_rename_and_duplicate() {
    let (_s, c, pid) = setup!("test_index_follows_publish_rename_and_duplicate");
    let page = publish(&c, &mk(&c, &pid, "Alpha", json!({})).await, "first draft zebra", None).await;
    assert_eq!(titles(&search(&c, &pid, "zebra", &[]).await), ["Alpha"]);
    publish(&c, &page, "now giraffe", None).await;
    assert!(titles(&search(&c, &pid, "zebra", &[]).await).is_empty());
    assert_eq!(titles(&search(&c, &pid, "giraffe", &[]).await), ["Alpha"]);
    c.patch(&format!("/docs/pages/{}", id(&page)), json!({"title": "Beta"})).await;
    assert!(titles(&search(&c, &pid, "alpha", &[]).await).is_empty());
    assert_eq!(titles(&search(&c, &pid, "beta", &[]).await), ["Beta"]);
    c.post(&format!("/docs/pages/{}/duplicate", id(&page)), json!({})).await;
    assert_eq!(sorted(titles(&search(&c, &pid, "giraffe", &[]).await)), ["Beta", "Beta (copy)"]);
    // a never-published page is found through its draft
    mk(&c, &pid, "Gamma", json!({"markdown": "platypus lives here"})).await;
    assert_eq!(titles(&search(&c, &pid, "platypus", &[]).await), ["Gamma"]);
    assert_eq!(search(&c, &pid, "platypus", &[]).await["pages"][0]["status"], "draft");
    // restoring an old version re-indexes it
    c.post(&format!("/docs/pages/{}/versions/1/restore", id(&page)), json!({})).await;
    // v1 brings its own title back
    assert!(titles(&search(&c, &pid, "zebra", &[]).await).contains(&"Alpha".to_string()));
}

// --- filters and facets ------------------------------------------------------

#[tokio::test]
async fn test_filters_author_status_edited_since_under_page_has_tickets_sort() {
    let (_s, c, pid) = setup!("test_filters_author_status_edited_since_under_page_has_tickets_sort");
    let parent = publish(&c, &mk(&c, &pid, "Handbook", json!({})).await, "## H\nwidget parent", None).await;
    let kid = mk(&c, &pid, "Kid", json!({"parent_id": parent["id"]})).await;
    c.post(&format!("/projects/{pid}/members"), json!({"name": "Mai"})).await;
    let r = c
        .clone()
        .header("x-actor", "Mai")
        .post(&format!("/docs/pages/{}/publish", id(&kid)), json!({"base_version": 0, "markdown": "widget child"}))
        .await;
    assert_eq!(r.status, 200);
    mk(&c, &pid, "Loose", json!({"markdown": "widget draft"})).await;
    let t = new_ticket(&c, &pid, json!({"title": "T"})).await;
    let solo = publish(&c, &mk(&c, &pid, "Solo", json!({})).await, &format!("widget solo {}", id(&t)), None).await;

    let n = |v: Value| v["pages"].as_array().unwrap().len();
    assert_eq!(n(search(&c, &pid, "widget", &[]).await), 4);
    assert_eq!(titles(&search(&c, &pid, "widget", &[("author", "Mai")]).await), ["Kid"]);
    assert_eq!(sorted(titles(&search(&c, &pid, "widget", &[("status", "draft")]).await)), ["Loose"]);
    assert_eq!(
        sorted(titles(&search(&c, &pid, "widget", &[("status", "published")]).await)),
        ["Handbook", "Kid", "Solo"]
    );
    let under = id(&parent);
    assert_eq!(sorted(titles(&search(&c, &pid, "widget", &[("under_page", &under)]).await)), ["Handbook", "Kid"]);
    assert_eq!(sorted(titles(&search(&c, &pid, "widget", &[("page_id", &under)]).await)), ["Handbook", "Kid"]);
    assert_eq!(titles(&search(&c, &pid, "widget", &[("has_tickets", "true")]).await), ["Solo"]);
    assert_eq!(n(search(&c, &pid, "widget", &[("has_tickets", "false")]).await), 3);
    assert_eq!(n(search(&c, &pid, "widget", &[("edited_since", "2000-01-01")]).await), 4);
    assert_eq!(search(&c, &pid, "widget", &[("edited_since", "2999-01-01")]).await["total"], 0);
    assert_eq!(n(search(&c, &pid, "widget", &[("edited_since", "7d")]).await), 4);
    let bad =
        c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", "widget"), ("edited_since", "last week")]).await;
    assert!(bad.status == 422 && bad.json()["detail"]["code"] == "bad_filter");
    let by_edit = search(&c, &pid, "widget", &[("sort", "edited_at")]).await;
    assert_eq!(by_edit["pages"][0]["page_id"], solo["id"]); // the last one touched
    assert_eq!(c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", "w"), ("sort", "nope")]).await.status, 422);

    // facets ignore the narrowing filters
    let facets = search(&c, &pid, "widget", &[("author", "Mai")]).await["facets"].clone();
    let count = |key: &str, name: &str| -> BTreeMap<String, i64> {
        facets[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| (a[name].as_str().unwrap().to_string(), a["count"].as_i64().unwrap()))
            .collect()
    };
    assert_eq!(count("authors", "name"), BTreeMap::from([("Mai".to_string(), 1), ("user".to_string(), 3)]));
    assert_eq!(count("status", "name"), BTreeMap::from([("draft".to_string(), 1), ("published".to_string(), 3)]));
    assert_eq!(
        count("under", "title"),
        BTreeMap::from([("Handbook".to_string(), 2), ("Loose".to_string(), 1), ("Solo".to_string(), 1)])
    );
    assert_eq!(facets["has_tickets"], 1);
    assert_eq!(search(&c, &pid, "widget", &[]).await["match_count"], 4);
    assert_eq!(facets["edited"], json!({"any": 4, "day": 4, "week": 4, "month": 4}));
    // each result carries the tickets its page references (chips on the results page)
    let all = search(&c, &pid, "widget", &[]).await;
    let by_title: BTreeMap<&str, &Value> =
        all["pages"].as_array().unwrap().iter().map(|p| (p["title"].as_str().unwrap(), p)).collect();
    assert_eq!(by_title["Solo"]["tickets"], json!([{"ticket_id": t["id"], "status": t["status"]}]));
    assert_eq!(by_title["Kid"]["tickets"], json!([]));
}

#[tokio::test]
async fn test_pagination() {
    let (_s, c, pid) = setup!("test_pagination");
    for n in 0..5 {
        publish(&c, &mk(&c, &pid, &format!("Item {n}"), json!({})).await, "common text", None).await;
    }
    let first = search(&c, &pid, "common", &[("limit", "2")]).await;
    let rest = search(&c, &pid, "common", &[("limit", "2"), ("offset", "4")]).await;
    assert!(
        first["total"] == 5
            && first["pages"].as_array().unwrap().len() == 2
            && rest["pages"].as_array().unwrap().len() == 1
    );
    let ids = |v: &Value| -> BTreeSet<String> {
        v["pages"].as_array().unwrap().iter().map(|p| p["page_id"].as_str().unwrap().to_string()).collect()
    };
    assert!(ids(&first).intersection(&ids(&rest)).next().is_none());
}

#[tokio::test]
async fn test_results_show_the_parent_path() {
    let (_s, c, pid) = setup!("test_results_show_the_parent_path");
    let a = mk(&c, &pid, "Engineering", json!({})).await;
    let b = mk(&c, &pid, "Backend", json!({"parent_id": a["id"]})).await;
    publish(&c, &mk(&c, &pid, "Caching", json!({"parent_id": b["id"]})).await, "redis", None).await;
    let res = search(&c, &pid, "redis", &[]).await;
    assert_eq!(res["pages"][0]["path"], json!(["Engineering", "Backend"]));
}

#[tokio::test]
async fn test_suggestion_when_nothing_matches() {
    let (_s, c, pid) = setup!("test_suggestion_when_nothing_matches");
    corpus(&c, &pid).await;
    let res = search(&c, &pid, "ratte limitng", &[]).await;
    assert!(res["total"] == 0 && res["suggestion"] == "rate limiting");
    assert!(search(&c, &pid, "zzzzzz", &[]).await["suggestion"].is_null());
}

#[tokio::test]
async fn test_similar_pages_for_a_missing_slug() {
    let (_s, c, pid) = setup!("test_similar_pages_for_a_missing_slug");
    mk(&c, &pid, "Getting started", json!({})).await;
    mk(&c, &pid, "Rate limits", json!({})).await;
    mk(&c, &pid, "Deployment", json!({})).await;
    let r = c.get_query(&format!("/projects/{pid}/docs/similar"), &[("slug", "getting-start")]).await;
    assert_eq!(r.status, 200);
    let rows = r.json();
    assert_eq!(rows[0]["title"], "Getting started");
    let keys: BTreeSet<&str> = rows[0].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, BTreeSet::from(["page_id", "title", "path"]));
    assert_eq!(
        c.get_query(&format!("/projects/{pid}/docs/similar"), &[("slug", "xqzv")])
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(c.get(&format!("/projects/{pid}/docs/similar")).await.json(), json!([]));
    for n in 0..8 {
        mk(&c, &pid, &format!("Rate limit part {n}"), json!({})).await;
    }
    let r = c.get_query(&format!("/projects/{pid}/docs/similar"), &[("slug", "rate-limit")]).await;
    assert_eq!(r.json().as_array().unwrap().len(), 4);
}

// --- fallback ----------------------------------------------------------------

#[tokio::test]
async fn test_ensure_fts_creates_the_table_lazily_and_backfills() {
    let (s, c, pid) = setup!("test_ensure_fts_creates_the_table_lazily_and_backfills");
    publish(&c, &mk(&c, &pid, "Early page", json!({})).await, "pangolin", None).await;
    exec(&s, "DROP TABLE docs_fts", &[]).await;
    // recreated and backfilled on demand
    assert_eq!(titles(&search(&c, &pid, "pangolin", &[]).await), ["Early page"]);
}
