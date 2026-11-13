//! One check per route of the Docs half (`api/docs.py`): the answer of each route, for the success case and for each
//! error it has, as status and JSON with ids and times normalized (`took_ms` and the request ids too), must be what the
//! Python server answers. The expected answers are recorded from the Python server in
//! `contract/golden/docs_routes/<test>.json` and compared on both targets:
//!
//! `DOCS_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-docs --test docs_routes`
//!
//! A 422 for a body or query the server cannot read is compared by its status and the location of the field (the
//! wording is Pydantic's). The comment and import routes (part 2) are the last three tests; the Docs AI hand-off
//! routes are not served.

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use common::{exec, id, import, insert, member, mk, new_ticket, pid, project, publish};
use serde_json::{Map, Value, json};
use testkit::{Client, Resp, Server, normalize, skip_unless_available, target};

/// The recorded answers of one test, and what this run answers.
struct Rec {
    path: PathBuf,
    golden: Map<String, Value>,
    got: BTreeMap<String, Value>,
    record: bool,
}

impl Rec {
    fn new(name: &str) -> Rec {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../contract/golden/docs_routes")
            .join(format!("{name}.json"));
        let record = std::env::var("DOCS_ROUTES_RECORD").is_ok_and(|v| v == "1");
        if record {
            assert_eq!(format!("{:?}", target()), "Python", "record from the Python server");
        }
        let golden = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Map<String, Value>>(&text).expect("golden file parses"),
            Err(_) if record => Map::new(),
            Err(e) => panic!("{}: {e} (record it with DOCS_ROUTES_RECORD=1 PARITY_TARGET=python)", path.display()),
        };
        Rec { path, golden, got: BTreeMap::new(), record }
    }

    /// Note the answer under `label`.
    fn check(&mut self, label: &str, r: &Resp) {
        let mut entry = Map::new();
        entry.insert("status".into(), json!(r.status));
        let text = r.text();
        match serde_json::from_str::<Value>(&text) {
            Ok(mut body) if r.status == 422 && body["detail"].is_array() => {
                // the wording of a validation message is Pydantic's: the field is compared
                let locs: Vec<Value> =
                    body["detail"].as_array().expect("detail").iter().map(|d| d["loc"].clone()).collect();
                body = json!({"loc": locs});
                entry.insert("json".into(), body);
            }
            Ok(mut body) => {
                scrub(&mut body);
                entry.insert("json".into(), normalize(&body));
            }
            Err(_) => {
                entry.insert("text".into(), json!(text));
            }
        }
        if let Some(rid) = r.headers.get("x-request-id") {
            entry.insert("has_request_id".into(), json!(!rid.is_empty()));
        }
        assert!(self.got.insert(label.to_string(), Value::Object(entry)).is_none(), "label {label} twice");
    }

    /// Compare with the recorded answers (or record them).
    fn finish(self) {
        if self.record {
            let all: Map<String, Value> = self.got.into_iter().collect();
            std::fs::create_dir_all(self.path.parent().expect("folder")).expect("mkdir");
            let mut text = serde_json::to_string_pretty(&Value::Object(all)).expect("json");
            text.push('\n');
            std::fs::write(&self.path, text).expect("write the golden file");
            return;
        }
        let mut bad = Vec::new();
        for (label, got) in &self.got {
            match self.golden.get(label) {
                Some(want) if want == got => {}
                Some(want) => bad.push(format!("{label}\n  want {want}\n  got  {got}")),
                None => bad.push(format!("{label}: not recorded")),
            }
        }
        for label in self.golden.keys() {
            if !self.got.contains_key(label) {
                bad.push(format!("{label}: recorded but not asked"));
            }
        }
        assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.join("\n"));
    }
}

/// `took_ms` is a timing and `request_id` is random: both are left out.
fn scrub(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("took_ms");
            if let Some(r) = m.get_mut("request_id") {
                *r = json!("<request id>");
            }
            for x in m.values_mut() {
                scrub(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(scrub),
        _ => {}
    }
}

/// A server, a client and a project with a viewer, a member and an admin.
async fn world(name: &str) -> Option<(Server, Client, String)> {
    if !skip_unless_available(name) {
        return None;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    for (who, role) in [("Vera", "viewer"), ("Mia", "member"), ("Ada", "admin")] {
        member(&c, &pid, who, role).await;
    }
    Some((s, c, pid))
}

fn as_(c: &Client, who: &str) -> Client {
    c.clone().header("x-actor", who)
}

#[tokio::test]
async fn templates_tree_and_create_pages() {
    let Some((_s, c, pid)) = world("templates_tree_and_create_pages").await else { return };
    let mut rec = Rec::new("templates_tree_and_create_pages");
    rec.check("GET /docs/templates", &c.get("/docs/templates").await);
    rec.check("tree: empty", &c.get(&format!("/projects/{pid}/docs/tree")).await);
    rec.check("tree: unknown project", &c.get("/projects/nope/docs/tree").await);
    rec.check("tree: stranger", &as_(&c, "Stranger").get(&format!("/projects/{pid}/docs/tree")).await);
    let url = format!("/projects/{pid}/docs/pages");
    let top = c.post(&url, json!({"title": "Top"})).await;
    rec.check("create: blank", &top);
    let top_id = id(&top.json());
    rec.check(
        "create: template and markdown wins",
        &c.post(&url, json!({"title": "Spec", "template": "requirements", "markdown": "own text"})).await,
    );
    rec.check("create: template", &c.post(&url, json!({"title": "Req", "template": "requirements"})).await);
    rec.check("create: child", &c.post(&url, json!({"title": "Child", "parent_id": top_id})).await);
    rec.check("create: same title again", &c.post(&url, json!({"title": "Top"})).await);
    rec.check("create: empty body", &c.post(&url, json!({})).await);
    rec.check("create: title not text", &c.post(&url, json!({"title": 5})).await);
    rec.check("create: blank title", &c.post(&url, json!({"title": "  "})).await);
    rec.check("create: title too long", &c.post(&url, json!({"title": "t".repeat(201)})).await);
    rec.check("create: bad template", &c.post(&url, json!({"title": "x", "template": "nope"})).await);
    rec.check("create: parent missing", &c.post(&url, json!({"title": "x", "parent_id": "nope"})).await);
    let other = project(&c, "Other", "OTH").await;
    let foreign = mk(&c, &id(&other), "Foreign", json!({})).await;
    rec.check(
        "create: parent in another project",
        &c.post(&url, json!({"title": "x", "parent_id": foreign["id"]})).await,
    );
    let gone = mk(&c, &pid, "Gone", json!({})).await;
    c.delete(&format!("/docs/pages/{}", id(&gone))).await;
    rec.check("create: parent deleted", &c.post(&url, json!({"title": "x", "parent_id": gone["id"]})).await);
    rec.check("create: too large", &c.post(&url, json!({"title": "big", "markdown": "x".repeat(1_000_001)})).await);
    rec.check("create: unknown project", &c.post("/projects/nope/docs/pages", json!({"title": "x"})).await);
    rec.check("create: viewer", &as_(&c, "Vera").post(&url, json!({"title": "x"})).await);
    rec.check("create: stranger", &as_(&c, "Stranger").post(&url, json!({"title": "x"})).await);
    rec.check("create: member", &as_(&c, "Mia").post(&url, json!({"title": "By Mia"})).await);
    rec.check("tree: with pages", &c.get(&format!("/projects/{pid}/docs/tree")).await);
    rec.check("tree: as Mia sees her draft", &as_(&c, "Mia").get(&format!("/projects/{pid}/docs/tree")).await);
    c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    rec.check("create: docs disabled", &c.post(&url, json!({"title": "x"})).await);
    rec.check("tree: docs disabled", &as_(&c, "Mia").get(&format!("/projects/{pid}/docs/tree")).await);
    rec.finish();
}

#[tokio::test]
async fn lookups_by_path_slug_similar_search_resolve_and_the_bin() {
    let Some((_s, c, pid)) = world("lookups_by_path_slug_similar_search_resolve_and_the_bin").await else { return };
    let mut rec = Rec::new("lookups_by_path_slug_similar_search_resolve_and_the_bin");
    let arch = publish(
        &c,
        &mk(&c, &pid, "Architecture", json!({})).await,
        "## Layers\nRate limiting lives in the API layer.",
        None,
    )
    .await;
    let api = publish(
        &c,
        &mk(&c, &pid, "API", json!({"parent_id": arch["id"]})).await,
        "## Endpoints\nSee [[Architecture#Layers]] and KAN-1.",
        None,
    )
    .await;
    new_ticket(&c, &pid, json!({"title": "Rate limiting bug", "description": "see [[API]]"})).await;
    let base = format!("/projects/{pid}/docs");
    rec.check("by-path: ok", &c.get_query(&format!("{base}/by-path"), &[("path", "architecture/api")]).await);
    rec.check("by-path: by id of the slug", &c.get_query(&format!("{base}/by-path"), &[("path", "api")]).await);
    rec.check("by-path: only slashes", &c.get_query(&format!("{base}/by-path"), &[("path", "//")]).await);
    rec.check("by-path: unknown", &c.get_query(&format!("{base}/by-path"), &[("path", "no/such")]).await);
    rec.check("by-path: no query", &c.get(&format!("{base}/by-path")).await);
    rec.check("by-path: unknown project", &c.get_query("/projects/nope/docs/by-path", &[("path", "x")]).await);
    rec.check("by-slug: ok", &c.get(&format!("{base}/by-slug/api")).await);
    rec.check("by-slug: unknown", &c.get(&format!("{base}/by-slug/nope")).await);
    rec.check("similar: ok", &c.get_query(&format!("{base}/similar"), &[("slug", "archtecture")]).await);
    rec.check("similar: no slug", &c.get(&format!("{base}/similar")).await);
    rec.check("similar: unknown project", &c.get("/projects/nope/docs/similar").await);
    let search = |q: &'static str, extra: Vec<(&'static str, &'static str)>| {
        let c = c.clone();
        let url = format!("{base}/search");
        async move {
            let mut query = vec![("q", q)];
            query.extend(extra);
            c.get_query(&url, &query).await
        }
    };
    rec.check("search: words", &search("rate limiting", vec![]).await);
    rec.check("search: headings", &search("#layers", vec![("mode", "headings")]).await);
    rec.check("search: tickets scope", &search("rate", vec![("scope", "tickets")]).await);
    rec.check("search: all scope", &search("rate", vec![("scope", "all")]).await);
    rec.check(
        "search: filters",
        &search(
            "api",
            vec![
                ("author", "user"),
                ("status", "published"),
                ("sort", "edited_at"),
                ("has_tickets", "true"),
                ("limit", "1"),
            ],
        )
        .await,
    );
    rec.check("search: typo", &search("ratte limitng", vec![]).await);
    rec.check("search: empty", &search("", vec![]).await);
    rec.check("search: bad scope", &search("x", vec![("scope", "galaxy")]).await);
    rec.check("search: bad sort", &search("x", vec![("sort", "nope")]).await);
    rec.check("search: bad mode", &search("x", vec![("mode", "nope")]).await);
    rec.check("search: bad filter", &search("x", vec![("edited_since", "last week")]).await);
    rec.check("search: limit not a number", &search("x", vec![("limit", "abc")]).await);
    rec.check("search: bool not a bool", &search("x", vec![("has_tickets", "maybe")]).await);
    rec.check("search: unknown project", &c.get_query("/projects/nope/docs/search", &[("q", "x")]).await);
    let resolve = format!("{base}/resolve");
    rec.check(
        "resolve: kinds",
        &c.post(&resolve, json!({"refs": [
            {"kind": "page", "title": "architecture", "anchor": "Layers"}, {"kind": "page", "title": "Architecture/API"},
            {"kind": "page", "title": "Architecture", "anchor": "Nope"}, {"kind": "page", "title": "Ghost"},
            {"kind": "ticket", "key": "KAN-1"}, {"kind": "ticket", "key": "KAN-99"}, {"kind": "ticket"},
            {"kind": "page", "title": "api", "by_slug": true}, {"title": "api"}, {}]}))
        .await,
    );
    rec.check(
        "resolve: from a ticket",
        &c.post(&resolve, json!({"refs": [{"kind": "page", "title": "API"}], "from_ticket": true})).await,
    );
    rec.check("resolve: no refs", &c.post(&resolve, json!({})).await);
    rec.check("resolve: refs not a list", &c.post(&resolve, json!({"refs": 3})).await);
    rec.check("resolve: unknown project", &c.post("/projects/nope/docs/resolve", json!({"refs": []})).await);
    // the bin
    rec.check("bin: empty", &c.get(&format!("{base}/recycle-bin")).await);
    c.delete(&format!("/docs/pages/{}", id(&api))).await;
    rec.check("bin: one deletion", &c.get(&format!("{base}/recycle-bin")).await);
    rec.check("bin: unknown project", &c.get("/projects/nope/docs/recycle-bin").await);
    rec.check("resolve: in the bin", &c.post(&resolve, json!({"refs": [{"kind": "page", "title": "API"}]})).await);
    rec.check("bin: viewer cannot empty it", &as_(&c, "Vera").delete(&format!("{base}/recycle-bin")).await);
    rec.check("bin: empty it", &c.delete(&format!("{base}/recycle-bin")).await);
    rec.check("bin: empty again", &c.delete(&format!("{base}/recycle-bin")).await);
    rec.check("bin: empty unknown project", &c.delete("/projects/nope/docs/recycle-bin").await);
    rec.finish();
}

#[tokio::test]
async fn pages_rename_move_duplicate_delete_restore_purge() {
    let Some((_s, c, pid)) = world("pages_rename_move_duplicate_delete_restore_purge").await else { return };
    let mut rec = Rec::new("pages_rename_move_duplicate_delete_restore_purge");
    let a = publish(&c, &mk(&c, &pid, "Alpha", json!({})).await, "## One\nfirst", None).await;
    let b = publish(&c, &mk(&c, &pid, "Beta", json!({})).await, "links to [[Alpha]] and [[Alpha#One]]", None).await;
    let kid = mk(&c, &pid, "Kid", json!({"parent_id": a["id"]})).await;
    let draft_only = mk(&c, &pid, "Draft", json!({"markdown": "wants [[Alpha]]"})).await;
    let page = |p: &Value| format!("/docs/pages/{}", id(p));
    rec.check("page: published", &c.get(&page(&a)).await);
    rec.check("page: draft", &c.get(&page(&kid)).await);
    rec.check("page: unknown", &c.get("/docs/pages/nope").await);
    rec.check("page: stranger", &as_(&c, "Stranger").get(&page(&a)).await);
    rec.check("rename-preview: ok", &c.get_query(&format!("{}/rename-preview", page(&a)), &[("title", "Omega")]).await);
    rec.check(
        "rename-preview: same title",
        &c.get_query(&format!("{}/rename-preview", page(&a)), &[("title", "Alpha")]).await,
    );
    rec.check("rename-preview: no title", &c.get(&format!("{}/rename-preview", page(&a))).await);
    rec.check("rename-preview: unknown", &c.get_query("/docs/pages/nope/rename-preview", &[("title", "x")]).await);
    rec.check("delete-preview: ok", &c.get(&format!("{}/delete-preview", page(&a))).await);
    rec.check("delete-preview: unknown", &c.get("/docs/pages/nope/delete-preview").await);
    rec.check("rename: viewer", &as_(&c, "Vera").patch(&page(&a), json!({"title": "x"})).await);
    rec.check(
        "rename: not linkable with rewrite",
        &c.patch(&page(&a), json!({"title": "a|b", "rewrite_links": true})).await,
    );
    rec.check("rename: blank", &c.patch(&page(&a), json!({"title": " "})).await);
    rec.check("rename: no title", &c.patch(&page(&a), json!({})).await);
    rec.check("rename: unknown", &c.patch("/docs/pages/nope", json!({"title": "x"})).await);
    rec.check("rename: with rewrite", &c.patch(&page(&a), json!({"title": "Omega", "rewrite_links": true})).await);
    rec.check("page: linker rewritten", &c.get(&page(&b)).await);
    rec.check("page: draft rewritten", &c.get(&page(&draft_only)).await);
    rec.check("rename: without rewrite", &c.patch(&page(&b), json!({"title": "Gamma"})).await);
    rec.check(
        "move: to the top before another",
        &c.post(&format!("{}/move", page(&kid)), json!({"parent_id": null, "before_id": b["id"]})).await,
    );
    rec.check(
        "move: after a sibling",
        &c.post(&format!("{}/move", page(&draft_only)), json!({"after_id": a["id"]})).await,
    );
    rec.check("move: under a parent", &c.post(&format!("{}/move", page(&b)), json!({"parent_id": a["id"]})).await);
    rec.check("move: into itself", &c.post(&format!("{}/move", page(&a)), json!({"parent_id": a["id"]})).await);
    rec.check("move: into its own child", &c.post(&format!("{}/move", page(&a)), json!({"parent_id": b["id"]})).await);
    rec.check(
        "move: anchor is not a sibling",
        &c.post(&format!("{}/move", page(&kid)), json!({"parent_id": a["id"], "before_id": a["id"]})).await,
    );
    rec.check("move: parent missing", &c.post(&format!("{}/move", page(&kid)), json!({"parent_id": "nope"})).await);
    rec.check("move: unknown page", &c.post("/docs/pages/nope/move", json!({})).await);
    rec.check("move: viewer", &as_(&c, "Vera").post(&format!("{}/move", page(&kid)), json!({})).await);
    rec.check("tree: after the moves", &c.get(&format!("/projects/{pid}/docs/tree")).await);
    rec.check("duplicate: default", &c.post(&format!("{}/duplicate", page(&a)), json!({})).await);
    rec.check(
        "duplicate: with children and a title",
        &c.post(&format!("{}/duplicate", page(&a)), json!({"title": "Twin", "include_children": true})).await,
    );
    rec.check(
        "duplicate: parent null is the top",
        &c.post(&format!("{}/duplicate", page(&b)), json!({"parent_id": null})).await,
    );
    rec.check(
        "duplicate: blank title is the default",
        &c.post(&format!("{}/duplicate", page(&kid)), json!({"title": ""})).await,
    );
    rec.check(
        "duplicate: title too long",
        &c.post(&format!("{}/duplicate", page(&kid)), json!({"title": "t".repeat(201)})).await,
    );
    rec.check("duplicate: unknown", &c.post("/docs/pages/nope/duplicate", json!({})).await);
    rec.check("duplicate: no body", &c.post_empty(&format!("{}/duplicate", page(&kid))).await);
    rec.check("tree: after the copies", &c.get(&format!("/projects/{pid}/docs/tree")).await);
    rec.check("delete: viewer", &as_(&c, "Vera").delete(&page(&a)).await);
    rec.check("delete: subtree", &c.delete(&page(&a)).await);
    rec.check("delete: again", &c.delete(&page(&a)).await);
    rec.check("delete: unknown", &c.delete("/docs/pages/nope").await);
    rec.check("page: deleted", &c.get(&page(&a)).await);
    rec.check("bin: after the delete", &c.get(&format!("/projects/{pid}/docs/recycle-bin")).await);
    rec.check("restore: not deleted", &c.post_empty(&format!("{}/restore", page(&b))).await);
    rec.check("restore: unknown", &c.post_empty("/docs/pages/nope/restore").await);
    rec.check("restore: viewer", &as_(&c, "Vera").post_empty(&format!("{}/restore", page(&a))).await);
    rec.check("restore: the root", &c.post_empty(&format!("{}/restore", page(&a))).await);
    c.delete(&page(&a)).await;
    rec.check("restore: only the child", &c.post_empty(&format!("{}/restore", page(&b))).await);
    rec.check("purge: not in the bin", &c.delete(&format!("{}/purge", page(&draft_only))).await);
    rec.check("purge: unknown", &c.delete("/docs/pages/nope/purge").await);
    rec.check("purge: viewer", &as_(&c, "Vera").delete(&format!("{}/purge", page(&a))).await);
    rec.check("purge: ok", &c.delete(&format!("{}/purge", page(&a))).await);
    rec.check("page: purged", &c.get(&page(&a)).await);
    rec.finish();
}

#[tokio::test]
async fn drafts_publish_versions_seen_and_followers() {
    let Some((_s, c, pid)) = world("drafts_publish_versions_seen_and_followers").await else { return };
    let mut rec = Rec::new("drafts_publish_versions_seen_and_followers");
    let p = mk(&c, &pid, "Doc", json!({})).await;
    let page = format!("/docs/pages/{}", id(&p));
    rec.check("draft: save", &c.put(&format!("{page}/draft"), json!({"markdown": "## A\nfirst"})).await);
    rec.check(
        "draft: save again with a title and a base",
        &c.put(&format!("{page}/draft"), json!({"markdown": "## A\nfirst!", "title": "Doc 2", "base_version": 0}))
            .await,
    );
    rec.check("draft: blank title", &c.put(&format!("{page}/draft"), json!({"markdown": "x", "title": " "})).await);
    rec.check("draft: too large", &c.put(&format!("{page}/draft"), json!({"markdown": "x".repeat(1_000_001)})).await);
    rec.check("draft: no markdown", &c.put(&format!("{page}/draft"), json!({})).await);
    rec.check("draft: unknown page", &c.put("/docs/pages/nope/draft", json!({"markdown": "x"})).await);
    rec.check("draft: viewer", &as_(&c, "Vera").put(&format!("{page}/draft"), json!({"markdown": "x"})).await);
    rec.check("draft: Mia's own", &as_(&c, "Mia").put(&format!("{page}/draft"), json!({"markdown": "mine"})).await);
    rec.check(
        "publish: no draft for Ada",
        &as_(&c, "Ada").post(&format!("{page}/publish"), json!({"base_version": 0})).await,
    );
    rec.check("publish: stale base", &c.post(&format!("{page}/publish"), json!({"base_version": 3})).await);
    rec.check("publish: no base", &c.post(&format!("{page}/publish"), json!({})).await);
    rec.check(
        "publish: too large",
        &c.post(&format!("{page}/publish"), json!({"base_version": 0, "markdown": "x".repeat(1_000_001)})).await,
    );
    rec.check("publish: unknown page", &c.post("/docs/pages/nope/publish", json!({"base_version": 0})).await);
    rec.check("publish: viewer", &as_(&c, "Vera").post(&format!("{page}/publish"), json!({"base_version": 0})).await);
    rec.check(
        "publish: ok with a note",
        &c.post(&format!("{page}/publish"), json!({"base_version": 0, "note": "  first cut  "})).await,
    );
    rec.check(
        "publish: markers, a title and notify",
        &c.post(&format!("{page}/publish"), json!({"base_version": 1, "markdown": "## B\n[Needs input: who?] and [Needs input]", "title": "Doc 3", "notify": true})).await,
    );
    rec.check(
        "publish: blank title",
        &c.post(&format!("{page}/publish"), json!({"base_version": 2, "markdown": "x", "title": "  "})).await,
    );
    rec.check("draft: discard none", &c.delete(&format!("{page}/draft")).await);
    c.put(&format!("{page}/draft"), json!({"markdown": "more"})).await;
    rec.check("draft: discard", &c.delete(&format!("{page}/draft")).await);
    rec.check("draft: discard unknown", &c.delete("/docs/pages/nope/draft").await);
    rec.check("draft: discard viewer", &as_(&c, "Vera").delete(&format!("{page}/draft")).await);
    rec.check("versions: list", &c.get(&format!("{page}/versions")).await);
    rec.check("versions: unknown page", &c.get("/docs/pages/nope/versions").await);
    rec.check("version: one", &c.get(&format!("{page}/versions/1")).await);
    rec.check("version: missing", &c.get(&format!("{page}/versions/9")).await);
    rec.check("version: not a number", &c.get(&format!("{page}/versions/x")).await);
    rec.check("diff: ok", &c.get(&format!("{page}/versions/1/diff/2")).await);
    rec.check("diff: reversed", &c.get(&format!("{page}/versions/2/diff/1")).await);
    rec.check("diff: missing", &c.get(&format!("{page}/versions/1/diff/9")).await);
    rec.check("restore version: ok", &c.post(&format!("{page}/versions/1/restore"), json!({})).await);
    rec.check(
        "restore version: with a note and notify",
        &c.post(&format!("{page}/versions/2/restore"), json!({"note": "back", "notify": true})).await,
    );
    rec.check("restore version: missing", &c.post(&format!("{page}/versions/9/restore"), json!({})).await);
    rec.check("restore version: unknown page", &c.post("/docs/pages/nope/versions/1/restore", json!({})).await);
    rec.check("restore version: viewer", &as_(&c, "Vera").post(&format!("{page}/versions/1/restore"), json!({})).await);
    rec.check("versions: after the restores", &c.get(&format!("{page}/versions")).await);
    rec.check("seen: never", &as_(&c, "Mia").get(&format!("{page}/seen")).await);
    rec.check("seen: mark", &as_(&c, "Mia").put(&format!("{page}/seen"), json!({"version": 2})).await);
    rec.check("seen: clamped", &as_(&c, "Mia").put(&format!("{page}/seen"), json!({"version": 99})).await);
    rec.check("seen: negative", &as_(&c, "Ada").put(&format!("{page}/seen"), json!({"version": -4})).await);
    rec.check("seen: read", &as_(&c, "Mia").get(&format!("{page}/seen")).await);
    rec.check("seen: no body", &c.put(&format!("{page}/seen"), json!({})).await);
    rec.check("seen: unknown", &c.get("/docs/pages/nope/seen").await);
    rec.check("seen: unknown put", &c.put("/docs/pages/nope/seen", json!({"version": 1})).await);
    let base = format!("/projects/{pid}/docs");
    rec.check("followers: none", &as_(&c, "Mia").get(&format!("{base}/followers")).await);
    rec.check("follow: on", &as_(&c, "Mia").put(&format!("{base}/follow"), json!({"on": true})).await);
    rec.check("follow: Ada on", &as_(&c, "Ada").put(&format!("{base}/follow"), json!({"on": true})).await);
    rec.check("followers: two", &as_(&c, "Mia").get(&format!("{base}/followers")).await);
    rec.check("follow: off", &as_(&c, "Mia").put(&format!("{base}/follow"), json!({"on": false})).await);
    rec.check("follow: no body", &c.put(&format!("{base}/follow"), json!({})).await);
    rec.check("follow: unknown project", &c.put("/projects/nope/docs/follow", json!({"on": true})).await);
    rec.check("followers: unknown project", &c.get("/projects/nope/docs/followers").await);
    rec.finish();
}

#[tokio::test]
async fn backlinks_work_assign_and_ticket_docs() {
    let Some((_s, c, pid)) = world("backlinks_work_assign_and_ticket_docs").await else { return };
    let mut rec = Rec::new("backlinks_work_assign_and_ticket_docs");
    let spec = publish(&c, &mk(&c, &pid, "Spec", json!({})).await, "## Design\nthe plan", None).await;
    let linker = publish(
        &c,
        &mk(&c, &pid, "Linker", json!({})).await,
        "## Notes\nWe follow [[Spec#Design]] here. Tracked in KAN-1.",
        None,
    )
    .await;
    let t1 = new_ticket(&c, &pid, json!({"title": "First", "description": "read [[Spec]]"})).await;
    let t2 = new_ticket(&c, &pid, json!({"title": "Second"})).await;
    let (k1, k2) = (id(&t1), id(&t2));
    rec.check("backlinks: ok", &c.get(&format!("/docs/pages/{}/backlinks", id(&spec))).await);
    rec.check("backlinks: unknown", &c.get("/docs/pages/nope/backlinks").await);
    rec.check("work: none", &c.get(&format!("/docs/pages/{}/work", id(&spec))).await);
    rec.check("work: unknown", &c.get("/docs/pages/nope/work").await);
    let assign = format!("/docs/pages/{}/assign", id(&spec));
    rec.check("assign: no such member", &c.post(&assign, json!({"member_id": "nope"})).await);
    rec.check(
        "assign: a person is not a team",
        &c.post(&assign, json!({"member_id": "nope", "kind": "write", "instruction": "x"})).await,
    );
    rec.check("assign: no body", &c.post(&assign, json!({})).await);
    rec.check("assign: unknown page", &c.post("/docs/pages/nope/assign", json!({"member_id": "m"})).await);
    rec.check("ticket docs: from the text", &c.get(&format!("/tickets/{k1}/docs")).await);
    rec.check("ticket docs: the page names it", &c.get(&format!("/tickets/{k1}/docs")).await);
    rec.check("ticket docs: none", &c.get(&format!("/tickets/{k2}/docs")).await);
    rec.check("ticket docs: unknown ticket", &c.get("/tickets/NOPE-1/docs").await);
    let link = |k: &str| format!("/tickets/{k}/docs");
    rec.check("link: manual", &c.post(&link(&k2), json!({"page_id": spec["id"]})).await);
    rec.check("link: again", &c.post(&link(&k2), json!({"page_id": spec["id"]})).await);
    rec.check("link: already by a mention", &c.post(&link(&k1), json!({"page_id": spec["id"]})).await);
    rec.check("link: already by the page", &c.post(&link(&k1), json!({"page_id": linker["id"]})).await);
    rec.check("link: unknown ticket", &c.post(&link("NOPE-1"), json!({"page_id": spec["id"]})).await);
    rec.check("link: unknown page", &c.post(&link(&k2), json!({"page_id": "nope"})).await);
    rec.check("link: no body", &c.post(&link(&k2), json!({})).await);
    let other = project(&c, "Other", "OTH").await;
    let foreign = mk(&c, &id(&other), "Foreign", json!({})).await;
    rec.check("link: another project", &c.post(&link(&k2), json!({"page_id": foreign["id"]})).await);
    rec.check("ticket docs: after the link", &c.get(&link(&k2)).await);
    rec.check("backlinks: with the manual link", &c.get(&format!("/docs/pages/{}/backlinks", id(&spec))).await);
    rec.check("page: stats count the tickets", &c.get(&format!("/docs/pages/{}", id(&spec))).await);
    rec.check("unlink: ok", &c.delete(&format!("/tickets/{k2}/docs/{}", id(&spec))).await);
    rec.check("unlink: nothing to remove", &c.delete(&format!("/tickets/{k2}/docs/{}", id(&spec))).await);
    rec.check("unlink: unknown ticket", &c.delete(&format!("/tickets/NOPE-1/docs/{}", id(&spec))).await);
    rec.check("ticket: activity of the links", &c.get(&format!("/tickets/{k2}")).await);
    c.delete(&format!("/docs/pages/{}", id(&spec))).await;
    rec.check("link: page in the bin", &c.post(&link(&k2), json!({"page_id": spec["id"]})).await);
    rec.check("ticket docs: page in the bin", &c.get(&link(&k1)).await);
    rec.finish();
}

#[tokio::test]
async fn access_and_access_requests() {
    let Some((_s, c, pid)) = world("access_and_access_requests").await else { return };
    let mut rec = Rec::new("access_and_access_requests");
    let url = format!("/projects/{pid}/docs/access");
    for who in ["user", "Vera", "Mia", "Ada", "agent", "Stranger"] {
        rec.check(&format!("access: {who}"), &as_(&c, who).get(&url).await);
    }
    rec.check("access: unknown project", &c.get("/projects/nope/docs/access").await);
    let ask = format!("/projects/{pid}/docs/access-requests");
    rec.check("request: stranger", &as_(&c, "Stranger").post(&ask, json!({"note": "  let me\n in  "})).await);
    rec.check("request: again", &as_(&c, "Stranger").post(&ask, json!({})).await);
    rec.check("request: a member", &as_(&c, "Mia").post(&ask, json!({"note": "x"})).await);
    rec.check("request: another stranger", &as_(&c, "Other").post(&ask, json!({"note": "n".repeat(400)})).await);
    rec.check("request: unknown project", &c.post("/projects/nope/docs/access-requests", json!({})).await);
    rec.check("request: note not text", &c.post(&ask, json!({"note": 4})).await);
    c.patch(&format!("/projects/{pid}"), json!({"docs_edit_policy": "admins"})).await;
    rec.check("access: admins only, Mia", &as_(&c, "Mia").get(&url).await);
    c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    rec.check("access: docs disabled", &as_(&c, "Stranger").get(&url).await);
    rec.check("request: docs disabled still answers", &as_(&c, "Third").post(&ask, json!({})).await);
    rec.finish();
}

const DOC: &str = "# API\n\nEvery route requires a bearer token; rotation rules live in [[Auth]].\n\n## Limits\n\nRate limits are not enforced yet. Tracked in KAN-12.\n";

fn anchor(quote: &str) -> Value {
    json!({"quote": quote, "prefix": "Every route requires a ", "suffix": "; rotation", "section": "api"})
}

#[tokio::test]
async fn comment_routes_every_branch() {
    let Some((s, c, pid)) = world("comment_routes_every_branch").await else { return };
    let mut rec = Rec::new("comment_routes_every_branch");
    // an AI member of the project (its mention is delivered to the Docs AI, which is off)
    insert(
        &s,
        "member",
        &json!({"id": "ai-robo", "project_id": pid, "name": "Robo", "color": "#3B82F6", "role": "member", "kind": "ai",
                "created_at": common::NOW}),
    )
    .await;
    let page = publish(&c, &mk(&c, &pid, "API", json!({})).await, DOC, None).await;
    let pg = id(&page);
    let list = format!("/docs/pages/{pg}/comments");
    rec.check("list: empty", &c.get(&list).await);
    rec.check("list: unknown page", &c.get("/docs/pages/nope/comments").await);
    rec.check("list: stranger", &as_(&c, "Stranger").get(&list).await);
    rec.check("list: bad state", &c.get_query(&list, &[("state", "nope")]).await);
    rec.check("list: empty state", &c.get_query(&list, &[("state", "")]).await);
    rec.check("list: bad kind", &c.get_query(&list, &[("kind", "nope")]).await);
    rec.check("list: empty kind", &c.get_query(&list, &[("kind", "")]).await);

    // start threads
    rec.check(
        "thread: inline",
        &c.post(&list, json!({"kind": "inline", "body": "Is this enough?", "anchor": anchor("bearer token")})).await,
    );
    let t1 = c.get(&list).await.json()["threads"][0]["id"].as_str().unwrap().to_string();
    rec.check(
        "thread: default kind is inline",
        &as_(&c, "Mia")
            .post(&list, json!({"body": " Padded \n", "anchor": anchor("Rate limits are not enforced")}))
            .await,
    );
    rec.check("thread: page comment", &c.post(&list, json!({"kind": "page", "body": "Looks good"})).await);
    rec.check(
        "thread: mention a member",
        &c.post(&list, json!({"kind": "page", "body": "@Mia and @[Ada](member:nope) please look, cc @Nobody"})).await,
    );
    rec.check("thread: mention an AI member", &c.post(&list, json!({"kind": "page", "body": "@Robo summarize"})).await);
    rec.check(
        "thread: AI mention with intent notify",
        &c.post(&list, json!({"kind": "page", "body": "@Robo FYI", "ai_intent": "notify"})).await,
    );
    rec.check(
        "thread: text not in the page yet",
        &c.post(&list, json!({"kind": "inline", "body": "x", "anchor": anchor("Not in the text")})).await,
    );
    rec.check(
        "thread: anchor with a section of nothing",
        &c.post(&list, json!({"kind": "inline", "body": "x", "anchor": {"quote": "Tracked in KAN-12", "section": ""}}))
            .await,
    );
    rec.check("thread: empty body", &c.post(&list, json!({"kind": "page", "body": "   "})).await);
    rec.check("thread: body too long", &c.post(&list, json!({"kind": "page", "body": "b".repeat(4001)})).await);
    rec.check("thread: body at the limit", &c.post(&list, json!({"kind": "page", "body": "b".repeat(4000)})).await);
    rec.check("thread: no body", &c.post(&list, json!({"kind": "page"})).await);
    rec.check("thread: body not text", &c.post(&list, json!({"kind": "page", "body": 7})).await);
    rec.check("thread: bad kind", &c.post(&list, json!({"kind": "weird", "body": "x"})).await);
    rec.check("thread: inline without anchor", &c.post(&list, json!({"kind": "inline", "body": "x"})).await);
    rec.check(
        "thread: anchor without quote",
        &c.post(&list, json!({"kind": "inline", "body": "x", "anchor": {"prefix": "a"}})).await,
    );
    rec.check(
        "thread: blank quote",
        &c.post(&list, json!({"kind": "inline", "body": "x", "anchor": {"quote": "   "}})).await,
    );
    rec.check(
        "thread: quote too long",
        &c.post(&list, json!({"kind": "inline", "body": "x", "anchor": {"quote": "q".repeat(2001)}})).await,
    );
    rec.check(
        "thread: anchor not an object",
        &c.post(&list, json!({"kind": "inline", "body": "x", "anchor": "text"})).await,
    );
    rec.check("thread: no body at all", &c.post(&list, json!({})).await);
    rec.check("thread: unknown page", &c.post("/docs/pages/nope/comments", json!({"kind": "page", "body": "x"})).await);
    rec.check("thread: viewer", &as_(&c, "Vera").post(&list, json!({"kind": "page", "body": "x"})).await);
    rec.check("thread: stranger", &as_(&c, "Stranger").post(&list, json!({"kind": "page", "body": "x"})).await);
    rec.check("list: all", &c.get(&list).await);
    rec.check("list: as the viewer", &as_(&c, "Vera").get(&list).await);
    rec.check("list: as Mia", &as_(&c, "Mia").get(&list).await);
    rec.check("list: kind page", &c.get_query(&list, &[("kind", "page")]).await);
    rec.check("list: kind inline, open", &c.get_query(&list, &[("kind", "inline"), ("state", "open")]).await);

    // anchor preview
    let preview = format!("/docs/pages/{pg}/comments/anchor-preview");
    rec.check(
        "preview: some orphaned",
        &c.post(&preview, json!({"markdown": "# API\n\nA bearer token is needed.\n"})).await,
    );
    rec.check("preview: none orphaned", &c.post(&preview, json!({"markdown": DOC})).await);
    rec.check("preview: viewer may ask", &as_(&c, "Vera").post(&preview, json!({"markdown": "x"})).await);
    rec.check("preview: no markdown", &c.post(&preview, json!({})).await);
    rec.check(
        "preview: unknown page",
        &c.post("/docs/pages/nope/comments/anchor-preview", json!({"markdown": "x"})).await,
    );

    // replies
    let replies = format!("/docs/comments/threads/{t1}/replies");
    rec.check("reply: ok", &as_(&c, "Mia").post(&replies, json!({"body": "Yes, @Ada"})).await);
    rec.check("reply: with an AI intent", &c.post(&replies, json!({"body": "Thanks", "ai_intent": "work"})).await);
    rec.check("reply: empty", &c.post(&replies, json!({"body": ""})).await);
    rec.check("reply: no body", &c.post(&replies, json!({})).await);
    rec.check("reply: unknown thread", &c.post("/docs/comments/threads/nope/replies", json!({"body": "x"})).await);
    rec.check("reply: viewer", &as_(&c, "Vera").post(&replies, json!({"body": "x"})).await);
    rec.check("reply: stranger", &as_(&c, "Stranger").post(&replies, json!({"body": "x"})).await);

    // read, resolve, reopen, reattach
    let thread = |action: &str, id: &str| format!("/docs/comments/threads/{id}/{action}");
    rec.check("read: ok", &as_(&c, "Mia").post_empty(&thread("read", &t1)).await);
    rec.check("read: unknown", &c.post_empty(&thread("read", "nope")).await);
    rec.check("resolve: ok", &as_(&c, "Mia").post_empty(&thread("resolve", &t1)).await);
    rec.check("resolve: again", &as_(&c, "Mia").post_empty(&thread("resolve", &t1)).await);
    rec.check("resolve: unknown", &c.post_empty(&thread("resolve", "nope")).await);
    rec.check("resolve: viewer", &as_(&c, "Vera").post_empty(&thread("resolve", &t1)).await);
    let page_thread =
        c.get_query(&list, &[("kind", "page")]).await.json()["threads"][0]["id"].as_str().unwrap().to_string();
    rec.check("resolve: a page comment", &c.post_empty(&thread("resolve", &page_thread)).await);
    rec.check("reopen: ok", &c.post_empty(&thread("reopen", &t1)).await);
    rec.check("reopen: already open", &c.post_empty(&thread("reopen", &t1)).await);
    rec.check("reopen: unknown", &c.post_empty(&thread("reopen", "nope")).await);
    rec.check("reopen: viewer", &as_(&c, "Vera").post_empty(&thread("reopen", &t1)).await);
    rec.check("reopen: a page comment", &c.post_empty(&thread("reopen", &page_thread)).await);
    rec.check(
        "reattach: ok",
        &c.post(
            &thread("reattach", &t1),
            json!({"quote": "Rate limits", "prefix": "", "suffix": " are", "section": "limits"}),
        )
        .await,
    );
    rec.check("reattach: text not in the page", &c.post(&thread("reattach", &t1), json!({"quote": "Not there"})).await);
    rec.check("reattach: no selection", &c.post(&thread("reattach", &t1), json!({"quote": "  "})).await);
    rec.check("reattach: too long", &c.post(&thread("reattach", &t1), json!({"quote": "q".repeat(2001)})).await);
    rec.check("reattach: no quote", &c.post(&thread("reattach", &t1), json!({})).await);
    rec.check("reattach: a page comment", &c.post(&thread("reattach", &page_thread), json!({"quote": "x"})).await);
    rec.check("reattach: unknown", &c.post(&thread("reattach", "nope"), json!({"quote": "x"})).await);
    rec.check("reattach: viewer", &as_(&c, "Vera").post(&thread("reattach", &t1), json!({"quote": "x"})).await);

    // edit and delete
    let t = c.get_query(&list, &[("kind", "inline")]).await.json();
    let mine = t["threads"].as_array().unwrap().iter().find(|x| x["id"] == t1.as_str()).unwrap().clone();
    let first = mine["comments"][0]["id"].as_str().unwrap().to_string();
    let reply = mine["comments"][1]["id"].as_str().unwrap().to_string();
    let comment = |id: &str| format!("/docs/comments/{id}");
    rec.check("edit: not the author", &c.patch(&comment(&first), json!({"body": "Hack"})).await);
    rec.check("edit: ok", &as_(&c, "Mia").patch(&comment(&reply), json!({"body": "Edited @Ada"})).await);
    rec.check("edit: same text", &as_(&c, "Mia").patch(&comment(&reply), json!({"body": "Edited @Ada"})).await);
    rec.check("edit: empty", &as_(&c, "Mia").patch(&comment(&reply), json!({"body": " "})).await);
    rec.check("edit: too long", &as_(&c, "Mia").patch(&comment(&reply), json!({"body": "b".repeat(4001)})).await);
    rec.check("edit: no body", &as_(&c, "Mia").patch(&comment(&reply), json!({})).await);
    rec.check("edit: unknown", &c.patch(&comment("nope"), json!({"body": "x"})).await);
    rec.check("edit: viewer", &as_(&c, "Vera").patch(&comment(&reply), json!({"body": "x"})).await);
    rec.check("delete: unknown", &c.delete(&comment("nope")).await);
    rec.check("delete: viewer", &as_(&c, "Vera").delete(&comment(&reply)).await);
    rec.check("delete: a member, not the author", &as_(&c, "Mia").delete(&comment(&first)).await);
    rec.check("delete: a reply", &as_(&c, "Mia").delete(&comment(&reply)).await);
    rec.check("delete: the first comment removes the thread", &as_(&c, "Ada").delete(&comment(&first)).await);
    rec.check("list: after", &c.get(&list).await);
    // the stranger and the viewer of a page in the bin
    c.delete(&format!("/docs/pages/{pg}")).await;
    rec.check("list: page in the bin", &c.get(&list).await);
    rec.check("thread: page in the bin", &c.post(&list, json!({"kind": "page", "body": "x"})).await);
    rec.check("preview: page in the bin", &c.post(&preview, json!({"markdown": "x"})).await);
    rec.check("reply: page in the bin", &c.post(&replies, json!({"body": "x"})).await);
    rec.check("resolve: page in the bin", &c.post_empty(&thread("resolve", &t1)).await);
    // Docs AI on: AI members of the list carry their status
    c.post_empty(&format!("/docs/pages/{pg}/restore")).await;
    exec(&s, "UPDATE docs_ai_settings SET enabled = 1 WHERE project_id = ?", &[json!(pid)]).await;
    rec.check("list: docs AI on", &c.get(&list).await);
    rec.check(
        "thread: docs AI on, AI mention to notify",
        &c.post(&list, json!({"kind": "page", "body": "@Robo FYI", "ai_intent": "notify"})).await,
    );
    // the Docs AI hand-off routes are not served here, but `DELETE /tickets/{ticket_id}/docs/comments` is the
    // `{page_id}` route of the ticket links (Python registers that one first): it unlinks a page called "comments"
    let ticket = new_ticket(&c, &pid, json!({"title": "T", "type": "task"})).await;
    rec.check(
        "ticket docs: DELETE .../docs/comments is the page route",
        &c.delete(&format!("/tickets/{}/docs/comments", id(&ticket))).await,
    );
    rec.check("ticket docs: DELETE with an unknown ticket", &c.delete("/tickets/NOPE-1/docs/comments").await);
    // documents disabled
    c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    rec.check("list: docs disabled", &c.get(&list).await);
    rec.check("thread: docs disabled", &c.post(&list, json!({"kind": "page", "body": "x"})).await);
    rec.finish();
}

#[tokio::test]
async fn comment_events_route() {
    let Some((_s, c, pid)) = world("comment_events_route").await else { return };
    let mut rec = Rec::new("comment_events_route");
    let page = publish(&c, &mk(&c, &pid, "API", json!({})).await, DOC, None).await;
    let list = format!("/docs/pages/{}/comments", id(&page));
    let url = format!("/projects/{pid}/docs/comment-events");
    rec.check("events: none yet", &c.get(&url).await);
    let t = as_(&c, "Mia").post(&list, json!({"kind": "inline", "body": "@Ada look [x](diagram:dg_1) ![i](/u/a.png)", "anchor": anchor("bearer token")})).await.json();
    as_(&c, "Ada").post(&format!("/docs/comments/threads/{}/replies", id(&t)), json!({"body": "Seen"})).await;
    as_(&c, "Ada").post_empty(&format!("/docs/comments/threads/{}/resolve", id(&t))).await;
    as_(&c, "Mia").post_empty(&format!("/docs/comments/threads/{}/reopen", id(&t))).await;
    as_(&c, "Stranger").post(&format!("/projects/{pid}/docs/access-requests"), json!({"note": "let me in"})).await;
    rec.check("events: all", &c.get(&url).await);
    rec.check("events: for Ada", &c.get_query(&url, &[("recipient", "Ada")]).await);
    rec.check("events: for ada, any case", &c.get_query(&url, &[("recipient", "ADA")]).await);
    rec.check("events: for Mia", &c.get_query(&url, &[("recipient", "Mia")]).await);
    rec.check("events: for the board's user", &c.get_query(&url, &[("recipient", "user")]).await);
    rec.check("events: for nobody", &c.get_query(&url, &[("recipient", "Nobody")]).await);
    rec.check("events: empty recipient", &c.get_query(&url, &[("recipient", "")]).await);
    rec.check("events: limit 2", &c.get_query(&url, &[("limit", "2")]).await);
    rec.check("events: limit 0", &c.get_query(&url, &[("limit", "0")]).await);
    rec.check("events: limit negative", &c.get_query(&url, &[("limit", "-5")]).await);
    rec.check("events: limit 1000", &c.get_query(&url, &[("limit", "1000")]).await);
    rec.check("events: limit with a recipient", &c.get_query(&url, &[("limit", "1"), ("recipient", "Ada")]).await);
    rec.check("events: limit not a number", &c.get_query(&url, &[("limit", "abc")]).await);
    rec.check("events: unknown project", &c.get("/projects/nope/docs/comment-events").await);
    rec.check(
        "events: another project",
        &c.get(&format!("/projects/{}/docs/comment-events", id(&project(&c, "Other", "OTH").await))).await,
    );
    rec.check("events: a stranger reads them", &as_(&c, "Stranger").get(&url).await);
    c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    rec.check("events: docs disabled", &c.get(&url).await);
    rec.finish();
}

#[tokio::test]
async fn import_routes_every_branch() {
    let Some((_s, c, pid)) = world("import_routes_every_branch").await else { return };
    let mut rec = Rec::new("import_routes_every_branch");
    let base = format!("/projects/{pid}/docs/import");
    let post = |files: &[(&str, &str)], fields: &[(&str, &str)]| {
        let files: Vec<(String, Vec<u8>)> = files.iter().map(|(p, t)| (p.to_string(), t.as_bytes().to_vec())).collect();
        let fields: Vec<(String, String)> = fields.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let (c, pid) = (c.clone(), pid.clone());
        async move {
            let refs: Vec<(&str, &[u8])> = files.iter().map(|(p, d)| (p.as_str(), d.as_slice())).collect();
            let f: Vec<(&str, &str)> = fields.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            import(&c, &pid, &refs, &f).await
        }
    };
    let existing = publish(&c, &mk(&c, &pid, "Existing", json!({})).await, "x", None).await;
    let files: &[(&str, &str)] = &[
        ("guide/setup.md", "# Setup\nSee [[Existing]] and [[Nowhere]] and [[Nowhere]]."),
        ("guide/index.md", "---\ntitle: Guide home\n---\nwelcome [[Setup]]"),
        ("Existing.md", "dup"),
        ("bad.md", "---\nitems: [unclosed\n---\nx"),
        ("notes.txt", "x"),
        ("../evil.md", "x"),
    ];
    rec.check("dry run", &post(files, &[("dry_run", "true")]).await);
    rec.check("dry run: skip", &post(files, &[("dry_run", "1"), ("on_conflict", "skip")]).await);
    rec.check("dry run: parent", &post(files, &[("dry_run", "yes"), ("parent_id", &id(&existing))]).await);
    rec.check("dry run: empty parent is the top", &post(files, &[("dry_run", "on"), ("parent_id", "")]).await);
    rec.check("dry run: bad conflict", &post(files, &[("dry_run", "true"), ("on_conflict", "overwrite")]).await);
    rec.check("dry run: bool not a bool", &post(files, &[("dry_run", "maybe")]).await);
    rec.check("dry run: publish not a bool", &post(files, &[("publish", "maybe")]).await);
    rec.check("dry run: parent missing", &post(files, &[("dry_run", "true"), ("parent_id", "nope")]).await);
    rec.check("dry run: unknown project", &import(&c, "nope", &[("a.md", b"a")], &[("dry_run", "true")]).await);
    let other = project(&c, "Other", "OTH").await;
    rec.check(
        "dry run: parent of another project",
        &import(&c, &id(&other), &[("a.md", b"a")], &[("dry_run", "true"), ("parent_id", &id(&existing))]).await,
    );
    rec.check("dry run: no files", &post(&[], &[("dry_run", "true")]).await);
    rec.check(
        "dry run: not a form",
        &c.request("POST", &base, &[("content-type", "application/json")], Some(b"{}".to_vec())).await,
    );
    let many: Vec<(String, &str)> = (0..201).map(|n| (format!("f{n}.md"), "x")).collect();
    let many_refs: Vec<(&str, &str)> = many.iter().map(|(p, t)| (p.as_str(), *t)).collect();
    rec.check("dry run: too many files", &post(&many_refs, &[("dry_run", "true")]).await);
    rec.check("dry run: a viewer may ask", &{
        let refs: Vec<(&str, &[u8])> = vec![("a.md", b"a")];
        let (ct, body) = common::multipart(&refs, &[("dry_run", "true")]);
        as_(&c, "Vera").request("POST", &base, &[("content-type", ct.as_str())], Some(body)).await
    });
    let as_member =
        |who: &'static str, files: Vec<(&'static str, &'static [u8])>, fields: Vec<(&'static str, &'static str)>| {
            let c = as_(&c, who);
            let base = base.clone();
            async move {
                let (ct, body) = common::multipart(&files, &fields);
                c.request("POST", &base, &[("content-type", ct.as_str())], Some(body)).await
            }
        };
    rec.check("import: viewer", &as_member("Vera", vec![("a.md", b"a")], vec![]).await);
    rec.check("import: stranger", &as_member("Stranger", vec![("a.md", b"a")], vec![("dry_run", "true")]).await);
    rec.check("import: the folder tree", &post(files, &[]).await);
    rec.check("tree after", &c.get(&format!("/projects/{pid}/docs/tree")).await);
    rec.check("import: again, copies", &post(files, &[("on_conflict", "copy")]).await);
    rec.check("import: again, skipped", &post(files, &[("on_conflict", "skip")]).await);
    rec.check(
        "import: published under a parent",
        &post(
            &[("pub/a.md", "# A\nsee [[B]]"), ("pub/b.md", "# B\ncontent")],
            &[("publish", "true"), ("parent_id", &id(&existing))],
        )
        .await,
    );
    rec.check(
        "import: published and notify",
        &post(&[("n.md", "# N\nx")], &[("publish", "true"), ("notify", "true")]).await,
    );
    rec.check("import: member", &as_member("Mia", vec![("mia.md", b"by mia")], vec![]).await);
    rec.check(
        "import: the last repeated field wins",
        &post(&[("r.md", "r")], &[("on_conflict", "overwrite"), ("on_conflict", "copy")]).await,
    );
    rec.check("import: paths and files that do not match", &{
        let (ct, body) = common::multipart(&[("one.md", b"1"), ("two.md", b"2")], &[]);
        // a text field named paths is read by the order; drop the second one so only the first file has a path
        let body = String::from_utf8_lossy(&body).replacen(
            "name=\"paths\"\r\n\r\ntwo.md\r\n--",
            "name=\"other\"\r\n\r\ntwo.md\r\n--",
            1,
        );
        c.request("POST", &base, &[("content-type", ct.as_str())], Some(body.into_bytes())).await
    });
    // resolve
    let ids: Vec<Value> = c
        .get(&format!("/projects/{pid}/docs/tree"))
        .await
        .json()
        .as_array()
        .unwrap()
        .iter()
        .take(6)
        .map(|r| r["id"].clone())
        .collect();
    let resolve = format!("{base}/resolve");
    rec.check("resolve: pages", &c.post(&resolve, json!({"page_ids": ids})).await);
    rec.check("resolve: unknown ids", &c.post(&resolve, json!({"page_ids": ["nope", "nada"]})).await);
    rec.check("resolve: none", &c.post(&resolve, json!({"page_ids": []})).await);
    rec.check("resolve: no body", &c.post(&resolve, json!({})).await);
    rec.check("resolve: ids not a list", &c.post(&resolve, json!({"page_ids": "x"})).await);
    rec.check("resolve: unknown project", &c.post("/projects/nope/docs/import/resolve", json!({"page_ids": []})).await);
    rec.check("resolve: viewer", &as_(&c, "Vera").post(&resolve, json!({"page_ids": []})).await);
    rec.check("resolve: stranger", &as_(&c, "Stranger").post(&resolve, json!({"page_ids": []})).await);
    rec.check(
        "resolve: pages of another project",
        &c.post(&format!("/projects/{}/docs/import/resolve", id(&other)), json!({"page_ids": ids})).await,
    );
    c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    rec.check("import: docs disabled", &post(&[("a.md", "a")], &[]).await);
    rec.check("dry run: docs disabled", &post(&[("a.md", "a")], &[("dry_run", "true")]).await);
    rec.check("resolve: docs disabled", &c.post(&resolve, json!({"page_ids": []})).await);
    rec.finish();
}
