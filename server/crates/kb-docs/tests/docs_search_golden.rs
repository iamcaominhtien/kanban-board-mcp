//! `contract/golden/docs_search.json`: what `services.docs_search.search` and `similar` answer over a corpus of pages
//! in English and Vietnamese, for a few hundred queries, on the FTS5 path and on the scan path. The corpus is
//! built here through the service (its own ids and times); ids are compared as `<p:Title>`, `took_ms` and
//! `updated_at` are left out. `extractOne` gets the vocabulary sorted (the Python run was made the same way).

use std::collections::HashMap;

use kb_base::{activity, ctx};
use kb_db::database;
use kb_db::entities::{member, project, ticket};
use kb_db::sea_orm::{ActiveModelTrait, Set};
use kb_docs::docs;
use kb_docs::docs_search::{self, SearchParams};
use serde_json::{Value, json};

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} in {v}"))
}

/// The golden result with ids as they are in the Rust corpus: nothing to do, they are names; the Rust result is
/// brought to the same form.
fn clean(value: &Value, ids: &HashMap<String, String>) -> Value {
    let mut text = serde_json::to_string(value).expect("json");
    for (id, name) in ids {
        text = text.replace(id.as_str(), name);
    }
    fn walk(v: Value) -> Value {
        match v {
            Value::Object(m) => Value::Object(
                m.into_iter().filter(|(k, _)| k != "took_ms" && k != "updated_at").map(|(k, x)| (k, walk(x))).collect(),
            ),
            Value::Array(a) => Value::Array(a.into_iter().map(walk).collect()),
            other => other,
        }
    }
    walk(serde_json::from_str(&text).expect("json"))
}

fn params_of(spec: &Value, ids: &HashMap<(String, String), String>) -> SearchParams {
    let mut p = SearchParams::default();
    for (k, v) in spec.as_object().expect("params") {
        let text = |v: &Value| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        match k.as_str() {
            "scope" => p.scope = text(v),
            "mode" => p.mode = Some(text(v)),
            "limit" => p.limit = v.as_i64().expect("limit"),
            "offset" => p.offset = v.as_i64().expect("offset"),
            "page_id" | "under_page" => {
                let t = text(v);
                let id = match t.strip_prefix('@') {
                    Some(title) => ids[&("Kanban".to_string(), title.to_string())].clone(),
                    None => t,
                };
                if k == "page_id" { p.page_id = Some(id) } else { p.under_page = Some(id) }
            }
            "author" => p.author = Some(text(v)),
            "edited_since" => p.edited_since = Some(text(v)),
            "has_tickets" => p.has_tickets = Some(text(v) == "true"),
            "status" => p.status = Some(text(v)),
            "sort" => p.sort = text(v),
            other => panic!("unknown parameter {other}"),
        }
    }
    p
}

#[tokio::test]
#[allow(unsafe_code)]
async fn search_answers_what_the_python_search_answers() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/docs_search.json");
    let golden: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("golden file")).expect("golden json");
    let dir = tempfile::tempdir().expect("temporary folder");
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("workspace"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("database setup");
    database::init_db().await.expect("schema");
    ctx::scope(run(golden)).await;
}

async fn run(golden: Value) {
    let setup = database::session();
    let mut pids: HashMap<String, String> = HashMap::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for p in golden["projects"].as_array().unwrap() {
        let mut row = project::new();
        row.name = Set(field(p, "name").to_string());
        row.prefix = Set(field(p, "prefix").to_string());
        row.color = Set("#123456".to_string());
        let row = row.insert(&setup).await.expect("project");
        names.insert(row.id.clone(), format!("<project:{}>", row.name));
        pids.insert(row.name.clone(), row.id);
    }
    for who in golden["members"].as_array().unwrap() {
        let mut row = member::new();
        row.project_id = Set(pids["Kanban"].clone());
        row.name = Set(who.as_str().unwrap().to_string());
        row.color = Set("#3B82F6".to_string());
        row.role = Set("member".to_string());
        row.insert(&setup).await.expect("member");
    }
    let mut counters: HashMap<String, usize> = HashMap::new();
    for t in golden["tickets"].as_array().unwrap() {
        let project = field(t, "project");
        let n = counters.entry(project.to_string()).or_default();
        *n += 1;
        let prefix = if project == "Kanban" { "KAN" } else { "OTH" };
        let mut row = ticket::new();
        row.id = Set(format!("{prefix}-{n}"));
        row.project_id = Set(pids[project].clone());
        row.title = Set(field(t, "title").to_string());
        row.description = Set(field(t, "description").to_string());
        row.insert(&setup).await.expect("ticket");
    }
    setup.commit().await.expect("commit");
    let mut by_title: HashMap<(String, String), String> = HashMap::new();
    for page in golden["pages"].as_array().unwrap() {
        let (project, title) = (field(page, "project"), field(page, "title"));
        let parent = page["parent"].as_str().map(|p| by_title[&(project.to_string(), p.to_string())].clone());
        let token = activity::set_actor(Some(field(page, "author")));
        let session = database::session();
        let made = docs::create_page(
            &session,
            &pids[project],
            title,
            parent.as_deref(),
            "blank",
            Some(field(page, "markdown")),
        )
        .await
        .unwrap_or_else(|e| panic!("create {title}: {e}"));
        let id = made["id"].as_str().expect("id").to_string();
        if page["publish"] == json!(true) {
            let session = database::session();
            docs::publish_page(&session, &id, 0, None, Some(field(page, "markdown")), None)
                .await
                .unwrap_or_else(|e| panic!("publish {title}: {e}"));
        }
        ctx::reset(token);
        names.insert(id.clone(), format!("<p:{title}>"));
        by_title.insert((project.to_string(), title.to_string()), id);
    }
    let pid = pids["Kanban"].clone();

    let mut failures: Vec<String> = Vec::new();
    let mut differing = 0;
    for case in golden["queries"].as_array().unwrap() {
        let q = field(case, "q");
        let params = params_of(&case["params"], &by_title);
        for (path, scan) in [("fts", false), ("scan", true)] {
            docs_search::set_fts_broken(scan);
            let session = database::session();
            let got = match docs_search::search(&session, &pid, q, &params).await {
                Ok(result) => clean(&Value::Object(result), &names),
                Err(kb_docs::Error::Docs(e)) => json!({"error": e.code}),
                Err(other) => panic!("{q:?}: {other}"),
            };
            let want = if scan && !case["scan"].is_null() { &case["scan"] } else { &case["fts"] };
            if got != *want {
                differing += 1;
                if failures.len() < 6 {
                    failures.push(format!("{path} q={q:?} params={}\n  want {want}\n  got  {got}", case["params"]));
                }
            }
        }
    }
    docs_search::set_fts_broken(false);
    assert!(failures.is_empty(), "{differing} differences, first ones:\n{}", failures.join("\n"));

    for case in golden["similar"].as_array().unwrap() {
        let slug = field(case, "slug");
        let session = database::session();
        let got = docs_search::similar(&session, &pid, slug).await.expect("similar");
        assert_eq!(clean(&Value::Array(got), &names), case["result"], "similar({slug:?})");
    }
}
