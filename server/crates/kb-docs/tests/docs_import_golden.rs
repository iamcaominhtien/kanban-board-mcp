//! `contract/golden/docs_import.json`: what `services.docs_import` answers for `clean_path`, the front matter read with
//! PyYAML `safe_load`, `parse_file` and the import plan (`build_plan`, and the per-file report of a dry run) over small
//! spaces, made by `contract/golden/gen_docs_import.py`.

use std::collections::HashMap;

use base64::Engine as _;
use kb_base::ctx;
use kb_db::database;
use kb_db::entities::project;
use kb_db::sea_orm::{ActiveModelTrait, Set};
use kb_docs::docs;
use kb_docs::docs_import::{self, Plan};
use serde_json::{Value, json};

fn golden() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract/golden/docs_import.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .expect("golden file parses")
}

#[test]
fn clean_path_gives_the_segments_python_gives() {
    let g = golden();
    for case in g["clean_path"].as_array().expect("cases") {
        let raw = case["raw"].as_str().expect("raw");
        let got = docs_import::clean_path(raw).map(|s| json!(s)).unwrap_or(Value::Null);
        assert_eq!(got, case["segments"], "{raw:?}");
    }
}

#[test]
fn front_matter_is_read_as_pyyaml_reads_it() {
    let g = golden();
    let mut bad = Vec::new();
    let cases = g["front_matter"].as_array().expect("cases");
    for case in cases {
        let text = case["text"].as_str().expect("text");
        match docs_import::split_front_matter(text) {
            Err(_) => {
                if case["crash"] != json!(true) {
                    bad.push(format!("{text:?}: crashed, Python answered {case}"));
                }
            }
            Ok(fm) => {
                if case["crash"] == json!(true) {
                    bad.push(format!("{text:?}: Python crashes, got {fm:?}"));
                    continue;
                }
                let want = (&case["meta"], case["body"].as_str().expect("body"), case["error_line"].as_u64());
                let got = (fm.meta.to_json(), fm.body.as_str(), fm.error_line.map(|l| l as u64));
                if (got.0 != *want.0) || got.1 != want.1 || got.2 != want.2 {
                    bad.push(format!("{text:?}\n   want {want:?}\n   got  {got:?}"));
                }
            }
        }
    }
    assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), cases.len(), bad.join("\n"));
}

#[test]
fn parse_file_gives_the_entry_python_gives() {
    let g = golden();
    let mut bad = Vec::new();
    for case in g["parse_file"].as_array().expect("cases") {
        let path = case["path"].as_str().expect("path");
        let data =
            base64::engine::general_purpose::STANDARD.decode(case["data"].as_str().expect("data")).expect("base64");
        let got = docs_import::parse_file(0, path, &data);
        if case["crash"] == json!(true) {
            if got.is_ok() {
                bad.push(format!("{path:?}: Python crashes"));
            }
            continue;
        }
        let Ok(e) = got else {
            bad.push(format!("{path:?}: crashed, Python answered {case}"));
            continue;
        };
        let got = json!({
            "segments": e.segments, "title": e.title, "explicit_title": e.explicit_title, "body": e.body, "size": e.size,
            "error": e.error, "is_index": e.is_index,
        });
        for key in ["segments", "title", "explicit_title", "body", "size", "error", "is_index"] {
            if got[key] != case[key] {
                bad.push(format!("{path:?} {key}: want {} got {}", case[key], got[key]));
            }
        }
    }
    assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.join("\n"));
}

fn entry_json(e: &docs_import::Entry) -> Value {
    json!({
        "path": e.path, "segments": e.segments, "title": e.title, "explicit_title": e.explicit_title, "body": e.body,
        "size": e.size, "error": e.error, "messages": e.messages, "skipped": e.skipped, "page_path": e.page_path,
        "resolved": e.resolved, "unresolved": e.unresolved, "is_index": e.is_index,
    })
}

fn nodes_json(plan: &Plan, titles: &HashMap<String, String>) -> Value {
    Value::Array(
        plan.ordered
            .iter()
            .map(|&n| {
                let node = &plan.arena[n];
                json!({
                    "key": node.key, "title": node.title, "body": node.body, "parent_key": node.parent_key,
                    "entry": node.entry.map(|i| plan.entries[i].index),
                    "existing": node.existing_id.as_ref().map(|id| titles[id].clone()),
                })
            })
            .collect(),
    )
}

#[tokio::test]
#[allow(unsafe_code)]
async fn the_plan_of_an_import_is_what_python_plans() {
    let dir = tempfile::tempdir().expect("temporary folder");
    // This test is the only one of its file that reads the folders; they are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("workspace"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("database setup");
    database::init_db().await.expect("schema");
    ctx::scope(plans()).await;
}

async fn plans() {
    let g = golden();
    let cases = g["plans"].as_array().expect("plans");
    let mut bad = Vec::new();
    for (n, case) in cases.iter().enumerate() {
        let session = database::session();
        let mut row = project::new();
        row.name = Set(format!("Space {n}"));
        row.prefix = Set(format!("P{n}"));
        row.color = Set("#123456".into());
        let pid = row.insert(&session).await.expect("project").id;
        session.commit().await.expect("commit");
        let mut by_title: HashMap<String, String> = HashMap::new();
        let mut titles: HashMap<String, String> = HashMap::new();
        for e in case["existing"].as_array().expect("existing") {
            let title = e[0].as_str().expect("title");
            let parent = e[1].as_str().and_then(|p| by_title.get(p)).cloned();
            let page = docs::create_page(&database::session(), &pid, title, parent.as_deref(), "blank", Some(""))
                .await
                .expect("page");
            let id = page["id"].as_str().expect("id").to_string();
            by_title.insert(title.to_string(), id.clone());
            titles.insert(id, title.to_string());
        }
        let files: Vec<(String, Vec<u8>)> = case["files"]
            .as_array()
            .expect("files")
            .iter()
            .map(|f| (f[0].as_str().expect("path").to_string(), f[1].as_str().expect("text").as_bytes().to_vec()))
            .collect();
        let parent = case["parent"].as_str().and_then(|p| by_title.get(p)).cloned();
        let conflict = case["on_conflict"].as_str().expect("on_conflict");
        let label = format!("plan {n}: {} files under {:?}, {conflict}", files.len(), case["parent"]);
        let session = database::session();
        let plan = docs_import::build_plan(&session, &pid, &files, parent.as_deref(), conflict).await;
        if let Some(want) = case.get("error") {
            match plan {
                Err(kb_docs::Error::Docs(e)) => {
                    let got = json!({"status": e.status, "code": e.code, "message": e.message});
                    if got != *want {
                        bad.push(format!("{label}: want {want} got {got}"));
                    }
                }
                other => bad.push(format!("{label}: want {want}, got {:?}", other.map(|p| p.summary))),
            }
            continue;
        }
        let plan = match plan {
            Ok(p) => p,
            Err(e) => {
                bad.push(format!("{label}: {e}"));
                continue;
            }
        };
        let entries = Value::Array(plan.entries.iter().map(entry_json).collect());
        if entries != case["entries"] {
            bad.push(format!("{label} entries:\n  want {}\n  got  {entries}", case["entries"]));
        }
        let nodes = nodes_json(&plan, &titles);
        if nodes != case["nodes"] {
            bad.push(format!("{label} nodes:\n  want {}\n  got  {nodes}", case["nodes"]));
        }
        if Value::Object(plan.summary.clone()) != case["summary"] {
            bad.push(format!("{label} summary: want {} got {}", case["summary"], Value::Object(plan.summary.clone())));
        }
        let report = Value::Array(plan.entries.iter().map(docs_import::file_report).collect());
        if report != case["report"] {
            bad.push(format!("{label} report:\n  want {}\n  got  {report}", case["report"]));
        }
    }
    assert!(bad.is_empty(), "{} of {} plans differ:\n{}", bad.len(), cases.len(), bad.join("\n"));
}
