//! `tests/test_docs_import.py`: Docs import: dry run, folder trees, titles, front matter, conflicts, limits and unsafe
//! paths. The unit tests of that file (`clean_path`, `collect_local`) call the functions of `kb_docs::docs_import`.

mod common;

use std::time::Duration;

use common::{id, import, mk, pid, project, publish};
use kb_docs::docs_import;
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

/// `(path, text)` pairs as the `files` of an upload.
type Files<'a> = &'a [(&'a str, &'a str)];

async fn upload(c: &Client, pid: &str, files: Files<'_>, fields: &[(&str, &str)]) -> testkit::Resp {
    let files: Vec<(&str, &[u8])> = files.iter().map(|(p, t)| (*p, t.as_bytes())).collect();
    import(c, pid, &files, fields).await
}

async fn dry(c: &Client, pid: &str, files: Files<'_>, fields: &[(&str, &str)]) -> Value {
    let mut all = vec![("dry_run", "true")];
    all.extend_from_slice(fields);
    let r = upload(c, pid, files, &all).await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

async fn do_import(c: &Client, pid: &str, files: Files<'_>, fields: &[(&str, &str)]) -> Value {
    let r = upload(c, pid, files, fields).await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

/// `tree(c, pid)`: the sorted paths of titles.
async fn tree(c: &Client, pid: &str) -> Vec<String> {
    let rows = c.get(&format!("/projects/{pid}/docs/tree")).await.json();
    let rows = rows.as_array().unwrap();
    let path = |r: &Value| -> String {
        let mut parts = vec![r["title"].as_str().unwrap().to_string()];
        let mut cur = r;
        while let Some(parent) = cur["parent_id"].as_str() {
            cur = rows.iter().find(|x| x["id"] == parent).unwrap();
            parts.insert(0, cur["title"].as_str().unwrap().to_string());
        }
        parts.join("/")
    };
    let mut out: Vec<String> = rows.iter().map(path).collect();
    out.sort();
    out
}

async fn rows_by_title(c: &Client, pid: &str) -> serde_json::Map<String, Value> {
    let rows = c.get(&format!("/projects/{pid}/docs/tree")).await.json();
    rows.as_array().unwrap().iter().map(|r| (r["title"].as_str().unwrap().to_string(), r.clone())).collect()
}

// --- dry run -----------------------------------------------------------------

#[tokio::test]
async fn test_dry_run_reports_the_plan_and_writes_nothing() {
    let (_s, c, pid) = setup!("test_dry_run_reports_the_plan_and_writes_nothing");
    publish(&c, &mk(&c, &pid, "Existing", json!({})).await, "x", None).await;
    let files: Files = &[
        ("guide/setup.md", "# Setup\nSee [[Existing]] and [[Nowhere]] and [[Nowhere]]."),
        ("guide/usage.md", "no title heading\n[[Setup]]"),
        ("readme-top.md", "---\ntitle: Top page\n---\nbody"),
    ];
    let out = dry(&c, &pid, files, &[]).await;
    let mut keys: Vec<&String> = out.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["bytes", "errors", "files", "links_resolved", "links_unresolved_total", "pages", "skipped"]);
    assert_eq!(out["pages"], 4); // the folder "guide" is a page too
    let by_path = |p: &str| out["files"].as_array().unwrap().iter().find(|f| f["path"] == p).unwrap().clone();
    assert_eq!(
        by_path("guide/setup.md"),
        json!({
            "path": "guide/setup.md",
            "page_path": ["guide", "Setup"],
            "title": "Setup",
            "status": "warning",
            "links_resolved": 1,
            "links_unresolved": ["Nowhere"],
            "message": "1 link not found yet",
        })
    );
    let usage = by_path("guide/usage.md");
    assert!(usage["title"] == "usage" && usage["status"] == "ok" && usage["links_resolved"] == 1); // [[Setup]] is in the batch
    assert_eq!(by_path("readme-top.md")["title"], "Top page");
    assert!(out["links_resolved"] == 2 && out["links_unresolved_total"] == 1 && out["skipped"] == 0);
    let bytes: usize = files.iter().map(|(_, b)| b.len()).sum();
    assert_eq!(out["bytes"], bytes);
    let paths: Vec<&str> = out["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, files.iter().map(|(p, _)| *p).collect::<Vec<_>>()); // input order
    assert_eq!(tree(&c, &pid).await, ["Existing"]);
}

// --- real run ----------------------------------------------------------------

#[tokio::test]
async fn test_folders_become_parent_pages_and_pages_are_drafts() {
    let (_s, c, pid) = setup!("test_folders_become_parent_pages_and_pages_are_drafts");
    let out = do_import(
        &c,
        &pid,
        &[
            ("docs/a.md", "# Alpha\n## Section\ntext"),
            ("docs/deep/b.markdown", "bee"),
            ("top.md", "---\ntitle: Top\n---\nt"),
        ],
        &[],
    )
    .await;
    assert!(out["failed"] == json!([]) && out["skipped"] == json!([]));
    let mut created: Vec<&str> =
        out["created"].as_array().unwrap().iter().map(|c| c["path"].as_str().unwrap()).collect();
    created.sort();
    assert_eq!(created, ["docs", "docs/a.md", "docs/deep", "docs/deep/b.markdown", "top.md"]);
    assert_eq!(tree(&c, &pid).await, ["Top", "docs", "docs/Alpha", "docs/deep", "docs/deep/b"]);
    let rows = rows_by_title(&c, &pid).await;
    assert!(rows.values().all(|r| r["status"] == "draft" && r["version"] == 0));
    let alpha = c.get(&format!("/docs/pages/{}", id(&rows["Alpha"]))).await.json();
    assert_eq!(alpha["draft"]["markdown"], "## Section\ntext"); // the title heading became the title
    assert!(alpha["status"] == "draft" && alpha["created_by"] == "user");
    assert_eq!(alpha["draft"]["base_version"], 0);
    let page_ids: Vec<&Value> =
        out["created"].as_array().unwrap().iter().filter(|c| c["path"] == "docs/a.md").map(|c| &c["page_id"]).collect();
    assert_eq!(page_ids, [&rows["Alpha"]["id"]]);
}

#[tokio::test]
async fn test_index_and_readme_become_the_folder_page_body() {
    let (_s, c, pid) = setup!("test_index_and_readme_become_the_folder_page_body");
    let out = do_import(
        &c,
        &pid,
        &[
            ("guides/index.md", "---\ntitle: All guides\n---\nwelcome"),
            ("guides/README.md", "# Readme heading\nreadme body"),
            ("guides/one.md", "one"),
            ("solo/README.md", "# Solo home\nhome body"),
            ("solo/two.md", "two"),
            ("plain/README.md", "no heading here"),
        ],
        &[],
    )
    .await;
    assert_eq!(out["failed"], json!([]));
    let paths = tree(&c, &pid).await;
    for p in ["All guides", "All guides/one", "All guides/Readme heading", "Solo home", "Solo home/two", "plain"] {
        assert!(paths.contains(&p.to_string()), "{p} in {paths:?}");
    }
    let rows = rows_by_title(&c, &pid).await;
    let draft = |title: &str| {
        let url = format!("/docs/pages/{}", id(&rows[title]));
        let c = c.clone();
        async move { c.get(&url).await.json()["draft"]["markdown"].clone() }
    };
    assert_eq!(draft("All guides").await, "welcome"); // index.md wins over README.md
    assert_eq!(draft("Solo home").await, "home body");
    assert_eq!(draft("plain").await, "no heading here"); // README without a title keeps the folder's name
}

#[tokio::test]
async fn test_titles_front_matter_beats_heading_beats_file_name() {
    let (_s, c, pid) = setup!("test_titles_front_matter_beats_heading_beats_file_name");
    let out = dry(
        &c,
        &pid,
        &[
            ("a.md", "---\ntitle: From front matter\nauthor: x\n---\n# A heading\nbody"),
            ("b.md", "# From heading\ntext"),
            ("c-file_name.md", "text only"),
            ("d.md", "---\ntitle: Same\n---\n# Same\nbody"),
            ("e.md", "```\n# not a heading\n```\nbody"),
            ("f.md", "\u{feff}# BOM heading\nx"),
        ],
        &[],
    )
    .await;
    let got: Vec<(&str, &str)> = out["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap(), f["title"].as_str().unwrap()))
        .collect();
    assert_eq!(
        got,
        [
            ("a.md", "From front matter"),
            ("b.md", "From heading"),
            ("c-file_name.md", "c-file_name"),
            ("d.md", "Same"),
            ("e.md", "e"),
            ("f.md", "BOM heading"),
        ]
    );
    let real = do_import(
        &c,
        &pid,
        &[("d.md", "---\ntitle: Same\n---\n# Same\nbody"), ("a.md", "---\ntitle: T\n---\n# Heading stays\nbody")],
        &[],
    )
    .await;
    let rows = rows_by_title(&c, &pid).await;
    let md = |t: &str| {
        let url = format!("/docs/pages/{}", id(&rows[t]));
        let c = c.clone();
        async move { c.get(&url).await.json()["draft"]["markdown"].clone() }
    };
    assert_eq!(md("Same").await, "body");
    assert_eq!(md("T").await, "# Heading stays\nbody");
    assert_eq!(real["created"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn test_front_matter_errors_name_the_line() {
    let (_s, c, pid) = setup!("test_front_matter_errors_name_the_line");
    let bad = "---\ntitle: ok\nitems: [unclosed\n---\nbody";
    let out = dry(&c, &pid, &[("bad.md", bad), ("good.md", "fine")], &[]).await;
    let f = &out["files"][0];
    assert!(f["status"] == "error" && f["title"].is_null() && f["page_path"].is_null());
    let message = f["message"].as_str().unwrap();
    assert!(message.starts_with("Front matter could not be read (line "));
    let line: i32 = message.split("line ").nth(1).unwrap().trim_end_matches(')').parse().unwrap();
    assert!(line == 3 || line == 4); // a line inside or just after the broken block
    assert!(out["errors"] == 1 && out["pages"] == 1);
    let real = do_import(&c, &pid, &[("bad.md", bad), ("good.md", "fine")], &[]).await;
    let failed: Vec<&str> = real["failed"].as_array().unwrap().iter().map(|x| x["path"].as_str().unwrap()).collect();
    assert_eq!(failed, ["bad.md"]);
    assert_eq!(real["failed"][0]["message"], f["message"]);
    assert_eq!(tree(&c, &pid).await, ["good"]);
    let scalar = dry(&c, &pid, &[("s.md", "---\njust a string\n---\nx")], &[]).await;
    assert_eq!(scalar["files"][0]["message"], "Front matter could not be read (line 1)");
    let unclosed = dry(&c, &pid, &[("u.md", "---\nnot closed\nbody")], &[]).await;
    assert_eq!(unclosed["files"][0]["status"], "ok"); // no closing marker: it is just text
}

// --- conflicts ---------------------------------------------------------------

#[tokio::test]
async fn test_conflict_copy_renames_and_skip_leaves_files_out() {
    let (_s, c, pid) = setup!("test_conflict_copy_renames_and_skip_leaves_files_out");
    mk(&c, &pid, "Notes", json!({})).await;
    let files: Files =
        &[("Notes.md", "a"), ("other/Notes.md", "b"), ("dupe.md", "# Twin\n1"), ("dupe2.md", "# Twin\n2")];
    let copy = dry(&c, &pid, files, &[("on_conflict", "copy")]).await;
    let by = |o: &Value, p: &str| o["files"].as_array().unwrap().iter().find(|f| f["path"] == p).unwrap().clone();
    assert!(by(&copy, "Notes.md")["title"] == "Notes (copy)" && by(&copy, "Notes.md")["status"] == "warning");
    assert!(by(&copy, "Notes.md")["message"].as_str().unwrap().contains("already exists"));
    // another parent: no clash
    assert!(by(&copy, "other/Notes.md")["title"] == "Notes" && by(&copy, "other/Notes.md")["status"] == "ok");
    let mut twins = vec![
        by(&copy, "dupe.md")["title"].as_str().unwrap().to_string(),
        by(&copy, "dupe2.md")["title"].as_str().unwrap().to_string(),
    ];
    twins.sort();
    assert_eq!(twins, ["Twin", "Twin (copy)"]);
    assert_eq!(copy["skipped"], 0);

    let skip = dry(&c, &pid, files, &[("on_conflict", "skip")]).await;
    let notes = by(&skip, "Notes.md");
    assert!(notes["status"] == "warning" && notes["page_path"].is_null());
    assert!(notes["message"].as_str().unwrap().starts_with("Skipped:"));
    assert!(skip["skipped"] == 2 && skip["pages"] == 3); // other + folder + one Twin

    let real = do_import(&c, &pid, files, &[("on_conflict", "skip")]).await;
    let mut skipped: Vec<&str> =
        real["skipped"].as_array().unwrap().iter().map(|s| s["path"].as_str().unwrap()).collect();
    skipped.sort();
    assert_eq!(skipped, ["Notes.md", "dupe2.md"]);
    assert_eq!(tree(&c, &pid).await, ["Notes", "Twin", "other", "other/Notes"]);
    let again = do_import(&c, &pid, files, &[("on_conflict", "copy")]).await;
    assert_eq!(again["created"].as_array().unwrap().len(), 5 - 1); // folder "other" is reused, not duplicated
    let paths = tree(&c, &pid).await;
    assert!(paths.iter().filter(|p| *p == "other").count() == 1);
    assert!(paths.contains(&"other/Notes (copy)".to_string()) && paths.contains(&"Notes (copy)".to_string()));
    let bad = upload(&c, &pid, files, &[("on_conflict", "overwrite")]).await;
    assert!(bad.status == 422 && bad.json()["detail"]["code"] == "bad_conflict");
}

#[tokio::test]
async fn test_importing_under_a_parent_page() {
    let (_s, c, pid) = setup!("test_importing_under_a_parent_page");
    let parent = mk(&c, &pid, "Imports", json!({})).await;
    mk(&c, &pid, "Taken", json!({"parent_id": parent["id"]})).await;
    let out = do_import(&c, &pid, &[("sub/x.md", "x"), ("Taken.md", "t")], &[("parent_id", &id(&parent))]).await;
    assert_eq!(out["created"].as_array().unwrap().len(), 3);
    assert_eq!(
        tree(&c, &pid).await,
        ["Imports", "Imports/Taken", "Imports/Taken (copy)", "Imports/sub", "Imports/sub/x"]
    );
    let other = project(&c, "O", "OOO").await;
    let r = upload(&c, &id(&other), &[("a.md", "a")], &[("parent_id", &id(&parent))]).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "bad_parent");
    let r = upload(&c, &pid, &[("a.md", "a")], &[("parent_id", "nope")]).await;
    assert_eq!(r.status, 404);
}

// --- limits and unsafe input -------------------------------------------------

#[tokio::test]
async fn test_wrong_extension_size_utf8_and_unsafe_paths_are_errors_not_crashes() {
    let (_s, c, pid) = setup!("test_wrong_extension_size_utf8_and_unsafe_paths_are_errors_not_crashes");
    let big = vec![b'x'; 2 * 1024 * 1024 + 1];
    let exact = vec![b'x'; 1_000_000];
    let two_mb = vec![b'x'; 2 * 1024 * 1024];
    let files: Vec<(&str, &[u8])> = vec![
        ("notes.txt", b"x"),
        ("big.md", &big),
        ("latin.md", b"caf\xe9 \xff"),
        ("../evil.md", b"x"),
        ("a/../../evil.md", b"x"),
        ("/abs/evil.md", b"x"),
        ("C:/win/evil.md", b"x"),
        ("back\\..\\evil.md", b"x"),
        ("ok.md", b"fine"),
        ("exact.md", &exact),
        ("two-mb.md", &two_mb),
    ];
    let r = import(&c, &pid, &files, &[("dry_run", "true")]).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let out = r.json();
    let msgs: std::collections::HashMap<&str, (&str, Option<&str>)> = out["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap(), (f["status"].as_str().unwrap(), f["message"].as_str())))
        .collect();
    assert_eq!(msgs["notes.txt"], ("error", Some("Only .md and .markdown files can be imported")));
    assert_eq!(msgs["big.md"], ("error", Some("File is larger than 2 MB")));
    assert_eq!(msgs["latin.md"], ("error", Some("File is not valid UTF-8 text")));
    for p in ["../evil.md", "a/../../evil.md", "/abs/evil.md", "C:/win/evil.md", "back\\..\\evil.md"] {
        assert!(msgs[p].0 == "error" && msgs[p].1.unwrap().starts_with("Unsafe path"), "{p}");
    }
    assert_eq!(msgs["ok.md"], ("ok", None));
    assert_eq!(msgs["exact.md"].0, "ok");
    // a page holds at most 1,000,000 characters
    assert_eq!(msgs["two-mb.md"], ("error", Some("File is too large for a page")));
    assert!(out["errors"] == 9 && out["pages"] == 2);
    let real = import(&c, &pid, &files, &[]).await.json();
    assert_eq!(real["failed"].as_array().unwrap().len(), 9);
    let mut created: Vec<&str> =
        real["created"].as_array().unwrap().iter().map(|x| x["path"].as_str().unwrap()).collect();
    created.sort();
    assert_eq!(created, ["exact.md", "ok.md"]);
    assert_eq!(tree(&c, &pid).await, ["exact", "ok"]);
}

#[tokio::test]
async fn test_dot_segments_are_harmless_and_case_of_extension_is_ignored() {
    let (_s, c, pid) = setup!("test_dot_segments_are_harmless_and_case_of_extension_is_ignored");
    let out = do_import(&c, &pid, &[("./a/./b.MD", "x"), ("c.Markdown", "y")], &[]).await;
    assert_eq!(out["failed"], json!([]));
    assert_eq!(tree(&c, &pid).await, ["a", "a/b", "c"]);
}

#[tokio::test]
async fn test_too_many_files_and_no_files() {
    let (_s, c, pid) = setup!("test_too_many_files_and_no_files");
    let names: Vec<String> = (0..201).map(|n| format!("f{n}.md")).collect();
    let files: Vec<(&str, &str)> = names.iter().map(|n| (n.as_str(), "x")).collect();
    let r = upload(&c, &pid, &files, &[("dry_run", "true")]).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "too_many_files");
    let ok = dry(&c, &pid, &files[..200], &[]).await;
    assert_eq!(ok["pages"], 200);
    // no files at all (validation)
    let r = upload(&c, &pid, &[], &[("dry_run", "true")]).await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn test_missing_paths_fall_back_to_the_upload_name() {
    let (_s, c, pid) = setup!("test_missing_paths_fall_back_to_the_upload_name");
    let r = c
        .upload(
            &format!("/projects/{pid}/docs/import"),
            "files",
            "loose.md",
            "application/octet-stream",
            b"hello".to_vec(),
            &[("dry_run", "true")],
        )
        .await;
    assert_eq!(r.json()["files"][0]["path"], "loose.md");
}

// --- links, publish, resolve post-pass --------------------------------------

#[tokio::test]
async fn test_import_keeps_links_as_written_and_resolve_pass_indexes_them() {
    let (_s, c, pid) = setup!("test_import_keeps_links_as_written_and_resolve_pass_indexes_them");
    let out =
        do_import(&c, &pid, &[("a.md", "# A\nsee [[B]] and [[Missing]]"), ("b.md", "# B\n## Part\nx")], &[]).await;
    let ids: Vec<&str> = out["created"].as_array().unwrap().iter().map(|x| x["page_id"].as_str().unwrap()).collect();
    let a = c.get(&format!("/docs/pages/{}", ids[0])).await.json();
    assert!(a["draft"]["markdown"].as_str().unwrap().contains("[[B]] and [[Missing]]"));
    let mut all: Vec<&str> = ids.clone();
    all.push("unknown-id");
    let r = c.post(&format!("/projects/{pid}/docs/import/resolve"), json!({"page_ids": all})).await;
    assert!(r.status == 200 && r.json() == json!({"pages": 2, "links_resolved": 1, "links_unresolved": 1}));
}

#[tokio::test]
async fn test_import_with_publish_creates_versions_and_links() {
    let (_s, c, pid) = setup!("test_import_with_publish_creates_versions_and_links");
    let out =
        do_import(&c, &pid, &[("a.md", "# A\nsee [[B]]"), ("b.md", "# B\ncontent")], &[("publish", "true")]).await;
    let by_title = |t: &str| {
        out["created"].as_array().unwrap().iter().find(|x| x["title"] == t).unwrap()["page_id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let a = c.get(&format!("/docs/pages/{}", by_title("A"))).await.json();
    assert!(a["status"] == "published" && a["version"] == 1 && a["draft"].is_null());
    let versions = c.get(&format!("/docs/pages/{}/versions", by_title("A"))).await.json();
    assert_eq!(versions[0]["note"], "Imported");
    let bl = c.get(&format!("/docs/pages/{}/backlinks", by_title("B"))).await.json();
    let from: Vec<&Value> = bl["pages"].as_array().unwrap().iter().map(|p| &p["page_id"]).collect();
    assert_eq!(from, [&json!(by_title("A"))]);
    let found = c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", "content")]).await.json();
    let titles: Vec<&str> = found["pages"].as_array().unwrap().iter().map(|p| p["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["B"]);
}

#[tokio::test]
async fn test_imported_drafts_are_searchable_by_title_and_body() {
    let (_s, c, pid) = setup!("test_imported_drafts_are_searchable_by_title_and_body");
    do_import(&c, &pid, &[("pangram.md", "# Zebra crossing\nquick brown fox")], &[]).await;
    let found = c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", "fox")]).await.json();
    let pages = found["pages"].as_array().unwrap();
    assert!(pages.len() == 1 && pages[0]["title"] == "Zebra crossing" && pages[0]["status"] == "draft");
}

/// The JSON events (`{...}`) that arrive within a moment, without the notification centre's "the log moved" ones.
async fn json_events(events: &mut testkit::Events) -> Vec<Value> {
    let mut out = Vec::new();
    while let Some(e) = events.next(Duration::from_millis(700)).await {
        if e.starts_with('{') {
            let v: Value = serde_json::from_str(&e).unwrap();
            if v["topics"] != json!(["notifications"]) {
                out.push(v);
            }
        }
    }
    out
}

#[tokio::test]
async fn test_import_notify_only_when_published_and_asked() {
    let (_s, c, pid) = setup!("test_import_notify_only_when_published_and_asked");
    let mut q = c.events().await;
    do_import(&c, &pid, &[("a.md", "x")], &[("publish", "true")]).await;
    assert!(json_events(&mut q).await.is_empty());
    do_import(&c, &pid, &[("b.md", "x")], &[("publish", "true"), ("notify", "true")]).await;
    let events = json_events(&mut q).await;
    assert!(events.len() == 1 && events[0]["type"] == "docs_published" && events[0]["title"] == "b", "{events:?}");
    do_import(&c, &pid, &[("c.md", "x")], &[("notify", "true")]).await; // drafts: nothing to announce
    assert!(json_events(&mut q).await.is_empty());
}

// --- unit helpers ------------------------------------------------------------

#[test]
fn test_clean_path() {
    let cases: [(&str, Option<Vec<&str>>); 10] = [
        ("a/b.md", Some(vec!["a", "b.md"])),
        ("./a//b.md", Some(vec!["a", "b.md"])),
        ("a\\b.md", Some(vec!["a", "b.md"])),
        ("../x.md", None),
        ("a/../b.md", None),
        ("/etc/passwd.md", None),
        ("", None),
        ("   ", None),
        ("a\x00b.md", None),
        ("D:\\x.md", None),
    ];
    for (raw, expected) in cases {
        let want = expected.map(|v| v.into_iter().map(String::from).collect::<Vec<_>>());
        assert_eq!(docs_import::clean_path(raw), want, "{raw:?}");
    }
}

fn names(found: &[(String, Vec<u8>)]) -> Vec<&str> {
    found.iter().map(|(p, _)| p.as_str()).collect()
}

#[test]
fn test_collect_local_walks_folders_and_skips_hidden_and_non_markdown() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let write = |rel: &str, text: &str| {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    write("a.md", "a");
    write("notes.txt", "t");
    write("sub/b.markdown", "b");
    write(".hidden/c.md", "c");
    write("node_modules/d.md", "d");
    let got = docs_import::collect_local(root.to_str().unwrap()).unwrap();
    assert_eq!(names(&got), ["a.md", "sub/b.markdown"]);
    assert_eq!(
        docs_import::collect_local(root.join("a.md").to_str().unwrap()).unwrap(),
        vec![("a.md".to_string(), b"a".to_vec())]
    );
    assert!(matches!(
        docs_import::collect_local(root.join("nope").to_str().unwrap()),
        Err(kb_docs::Error::Docs(e)) if e.status == 404
    ));
    std::fs::create_dir(root.join("empty")).unwrap();
    assert!(matches!(
        docs_import::collect_local(root.join("empty").to_str().unwrap()),
        Err(kb_docs::Error::Docs(e)) if e.status == 422
    ));
}

#[cfg(unix)]
#[test]
fn test_collect_local_ignores_symlinks_that_leave_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside.md");
    std::fs::write(&outside, "secret").unwrap();
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("ok.md"), "ok").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link.md")).unwrap();
    let got = docs_import::collect_local(root.to_str().unwrap()).unwrap();
    assert_eq!(names(&got), ["ok.md"]);
}
