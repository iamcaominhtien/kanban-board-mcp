//! A project's Docs worked through the MCP tools from start to finish, then what the database holds: the `docs_*`,
//! `diagram*`, `sketch`, `canvas*` and notification tables of `testkit`'s `dump_db`, and the files in the uploads
//! folder (by their SHA-256), ids, times and folders normalized, must be the same on both servers.
//!
//! The scenario makes a page tree (a root with two sub-pages and a second root), edits a section, renames and
//! moves, duplicates, searches, comments and replies and resolves, links a ticket, creates a diagram from a
//! `.drawio` file and saves a new version, makes a sketch, creates a canvas from a folder of frames and comments on
//! it, changes a frame, takes a picture, imports a folder of Markdown (as pages and as drafts), uploads files, makes
//! tickets from a checklist, and deletes and restores a page.
//!
//! The dump of the Python server is kept in `contract/golden/mcp_docs_scenario.json`; each server is compared with
//! it. To write it again after the scenario changes:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_docs_scenario`.

mod common;

use std::path::Path;

use common::call;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use testkit::{Mcp, Target, normalize, target};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/mcp_docs_scenario.json");

/// The tables to compare, besides those named `docs_*`, `diagram*`, `sketch*`, `canvas*` and `notif*`.
const ALSO: [&str; 1] = ["ticket"];
/// What a table holds that depends on the SQLite build: not compared.
const SKIP: [&str; 6] =
    ["docs_fts_config", "docs_fts_content", "docs_fts_data", "docs_fts_docsize", "docs_fts_idx", "canvas_proposal"];

async fn write(mcp: &Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_write", arguments).await
}

async fn read(mcp: &Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_read", arguments).await
}

fn text(value: &Value) -> String {
    value.as_str().expect("a text").to_string()
}

fn put(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().expect("a parent")).expect("a folder");
    std::fs::write(path, content).expect("a file");
}

async fn scenario(s: &testkit::Server, files: &Path) -> Vec<String> {
    let mcp = s.mcp();
    let c = s.client();
    let mut skipped_uploads: Vec<String> = Vec::new();
    let project = call(&mcp, "manage_project", json!({"action": "create", "name": "Handbook", "prefix": "HBK"})).await;
    let p = text(&project["id"]);
    call(&mcp, "manage_project", json!({"action": "add_member", "project_id": p, "name": "Bao"})).await;
    let ticket = call(
        &mcp,
        "manage_ticket",
        json!({"action": "create", "project_id": p, "title": "Rate limit", "type": "task"}),
    )
    .await;
    let t1 = text(&ticket["id"]);

    // a page tree
    let spec = "## Overview\n\nThe API is REST.\n\n## Endpoints\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n\n### Errors\n\n401 when the token is missing.\n\n## Limits\n\nRate limits are not enforced yet. See HBK-1.\n";
    let root = write(&mcp, "create", json!({"project_id": p, "title": "Handbook", "markdown": spec})).await;
    let root_id = text(&root["id"]);
    let setup = write(&mcp, "create", json!({"project_id": p, "title": "Setup", "markdown": "## Install\n\nRun it. See [[Handbook#Limits]].\n", "parent_id": root_id})).await;
    let setup_id = text(&setup["id"]);
    let usage = write(&mcp, "create", json!({"project_id": p, "title": "Usage", "markdown": "- [ ] Write the usage\n- [ ] Review the usage\n", "parent_id": root_id})).await;
    let usage_id = text(&usage["id"]);
    let other = write(&mcp, "create", json!({"project_id": p, "title": "Notes", "markdown": "free text"})).await;
    let other_id = text(&other["id"]);

    // edit, update, rename, move, duplicate
    write(
        &mcp,
        "edit",
        json!({"page_id": root_id, "section": "Limits", "markdown": "Rate limits are 100 per minute."}),
    )
    .await;
    write(
        &mcp,
        "edit",
        json!({"page_id": root_id, "find": "The API is REST.", "markdown": "The API is REST and JSON."}),
    )
    .await;
    let page = read(&mcp, "get", json!({"page_id": other_id})).await;
    write(&mcp, "update", json!({"page_id": other_id, "markdown": "more free text\n", "base_version": page["version"], "title": "Scratch notes", "note": "Renamed"})).await;
    write(
        &mcp,
        "update",
        json!({"page_id": other_id, "markdown": "a draft only\n", "base_version": 2, "publish": false}),
    )
    .await;
    write(&mcp, "move", json!({"page_id": other_id, "parent_id": setup_id})).await;
    let copy = write(&mcp, "duplicate", json!({"page_id": root_id, "include_children": true})).await;
    let copy_id = text(&copy["id"]);
    write(&mcp, "restore_version", json!({"page_id": root_id, "version": 1})).await;
    read(&mcp, "search", json!({"project_id": p, "query": "limits"})).await;
    read(&mcp, "versions", json!({"page_id": root_id})).await;

    // comments
    let thread =
        write(&mcp, "comment", json!({"page_id": root_id, "body": "Which format, @Bao?", "quote": "The API is REST"}))
            .await;
    let thread_id = text(&thread["id"]);
    write(&mcp, "comment", json!({"page_id": root_id, "body": "Needs an owner"})).await;
    let reply = c
        .header("x-actor", "Bao")
        .post(&format!("/docs/comments/threads/{thread_id}/replies"), json!({"body": "JSON."}))
        .await;
    reply.assert_status(201);
    let own = write(&mcp, "reply", json!({"thread_id": thread_id, "body": "Thanks"})).await;
    let own_id = text(&own["comments"][2]["id"]);
    write(&mcp, "edit_comment", json!({"comment_id": own_id, "body": "Thanks!"})).await;
    write(&mcp, "resolve", json!({"thread_id": thread_id})).await;
    write(&mcp, "reopen", json!({"thread_id": thread_id})).await;

    // a ticket linked to a page, tickets from a checklist, a file on a ticket
    call(&mcp, "manage_ticket", json!({"action": "link_doc", "ticket_id": t1, "page_id": setup_id})).await;
    write(&mcp, "tickets", json!({"page_id": usage_id})).await;
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
    write(&mcp, "upload", json!({"data": png, "name": "flow.png", "page_id": setup_id, "section": "Install"})).await;
    write(&mcp, "upload", json!({"data": "aGVsbG8K", "name": "log.txt", "ticket_id": t1, "body": "The log"})).await;

    // a diagram
    put(
        files,
        "flow.drawio",
        "<mxfile><diagram name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"a\" value=\"Client\" style=\"rounded=1;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"40\" y=\"40\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell><mxCell id=\"b\" value=\"API\" style=\"rounded=1;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"240\" y=\"40\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell><mxCell id=\"e\" value=\"calls\" style=\"endArrow=classic;\" edge=\"1\" parent=\"1\" source=\"a\" target=\"b\"><mxGeometry relative=\"1\" as=\"geometry\"/></mxCell></root></mxGraphModel></diagram></mxfile>",
    );
    let diagram = write(&mcp, "diagram_create", json!({"project_id": p, "title": "Request flow", "path": files.join("flow.drawio").to_string_lossy(), "summary": "Client calls the API"})).await;
    let diagram_id = text(&diagram["id"]);
    let out = files.join("out").to_string_lossy().into_owned();
    let exported = read(&mcp, "diagram", json!({"diagram_id": diagram_id, "path": out})).await;
    let edited = std::fs::read_to_string(text(&exported["path"])).expect("the file").replace("API", "API gateway");
    put(files, "flow2.drawio", &edited);
    write(&mcp, "diagram_save", json!({"diagram_id": diagram_id, "path": files.join("flow2.drawio").to_string_lossy(), "base_version": exported["version"]})).await;
    let usage_now = read(&mcp, "get", json!({"page_id": usage_id})).await;
    write(&mcp, "update", json!({"page_id": usage_id, "markdown": format!("## Flow\n\n{}\n", diagram["markdown"].as_str().expect("markdown")), "base_version": usage_now["version"]})).await;
    // a picture: the board keeps a copy in its uploads folder, drawn by whatever browser is there: not compared
    let picture =
        read(&mcp, "picture", json!({"diagram_id": diagram_id, "path": files.join("scenario-pic").to_string_lossy()}))
            .await;
    skipped_uploads.push(text(&picture["markdown"]));

    // a sketch
    put(files, "dot.sketch.json", &json!({"format": "kanban-sketch", "version": 1, "width": 1, "height": 1, "layers": [{"id": "l1", "name": "Layer 1", "kind": "draw", "visible": true, "opacity": 1, "data": ""}]}).to_string());
    std::fs::write(files.join("dot.png"), base64_png()).expect("a picture");
    let sketch = write(&mcp, "sketch_create", json!({"owner_kind": "doc", "owner_id": root_id, "title": "Sketch", "path": files.join("dot.png").to_string_lossy(), "source_path": files.join("dot.sketch.json").to_string_lossy()})).await;
    write(&mcp, "sketch_save", json!({"sketch_id": sketch["id"], "path": files.join("dot.png").to_string_lossy(), "base_version": 1, "title": "Sketch 2"})).await;

    // a canvas
    put(
        files,
        "canvas/01-home/index.html",
        "<!doctype html><title>Home</title><h1>Home</h1><button id=\"go\">Go</button>",
    );
    put(
        files,
        "canvas/01-home/frame.json",
        &json!({"name": "Home screen", "size": "phone", "page": "Screens"}).to_string(),
    );
    put(files, "canvas/02-detail/index.html", "<!doctype html><title>Detail</title><p>Detail</p>");
    put(files, "canvas/canvas.json", &json!({"notes": [{"id": "n1", "text": "Empty state?", "near": "01-home"}], "arrows": [{"from": "01-home", "to": "02-detail", "label": "tap"}]}).to_string());
    let canvas = write(&mcp, "canvas_create", json!({"path": files.join("canvas").to_string_lossy(), "owner_kind": "doc", "owner_id": setup_id, "title": "Mockups"})).await;
    let canvas_id = text(&canvas["id"]);
    let board = text(&canvas["boards"][0]["id"]);
    write(
        &mcp,
        "canvas_comment",
        json!({"canvas_id": canvas_id, "body": "Bigger button", "board_id": board, "at": "#go"}),
    )
    .await;
    write(&mcp, "canvas_comment", json!({"canvas_id": canvas_id, "body": "Too much grey"})).await;
    put(files, "edit/index.html", "<!doctype html><title>Home v2</title><h1>Home v2</h1>");
    write(&mcp, "canvas_update", json!({"canvas_id": canvas_id, "board_id": board, "path": files.join("edit").to_string_lossy(), "note": "New title"})).await;
    let setup_now = read(&mcp, "get", json!({"page_id": setup_id})).await;
    write(&mcp, "update", json!({"page_id": setup_id, "markdown": format!("## Install\n\nRun it.\n\n{}\n", canvas["markdown"].as_str().expect("markdown")), "base_version": setup_now["version"]})).await;

    // an import, as pages and as drafts
    put(files, "import/guide/intro.md", "# Intro\nSee [[Handbook]].\n");
    put(files, "import/notes.md", "---\ntitle: Imported notes\n---\nhello\n");
    write(&mcp, "import", json!({"project_id": p, "path": files.join("import").to_string_lossy()})).await;
    write(&mcp, "import", json!({"project_id": p, "path": files.join("import").to_string_lossy(), "publish": false, "parent_id": setup_id})).await;

    // the bin
    write(&mcp, "delete", json!({"page_id": copy_id})).await;
    read(&mcp, "recycle_bin", json!({"project_id": p})).await;
    write(&mcp, "restore", json!({"page_id": copy_id})).await;
    write(&mcp, "delete", json!({"page_id": other_id})).await;
    skipped_uploads
}

fn base64_png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0xf8, 0x0f, 0x00, 0x01, 0x04, 0x01, 0x00,
        0xc1, 0x2d, 0x8e, 0x50, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]
}

/// The rows of a table as the dump gives them, in an order that does not depend on the ids and times each server
/// made: sorted by the row with every id and time left out.
fn stable(rows: &Value, pages: &std::collections::HashMap<String, String>) -> Vec<Value> {
    static VARIABLE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b|\b(?:dg|sk|cv|b|n|a|t|p|nt)_[0-9a-f]{8,12}\b|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
        )
        .expect("a pattern")
    });
    let mut keyed: Vec<(String, Value)> = rows
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| {
            // a page is known by its slug, so that rows of two pages that differ only by their ids keep an order
            let mut shown = row.to_string();
            for (id, slug) in pages {
                shown = shown.replace(id.as_str(), &format!("page:{slug}"));
            }
            (VARIABLE.replace_all(&shown, "<x>").into_owned(), row.clone())
        })
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    keyed.into_iter().map(|(_, row)| row).collect()
}

/// The files under the uploads folder: their path below it, with the random parts numbered, and their SHA-256.
fn uploaded(root: &Path, skip: &[String]) -> Vec<Value> {
    fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(list) = std::fs::read_dir(dir) else { return };
        for entry in list.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut paths = Vec::new();
    walk(root, &mut paths);
    static RANDOM: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"-[0-9a-f]{6,12}(\.[a-z0-9]+)$").expect("a pattern"));
    static SHORT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\b(dg|sk|cv|b|n|a|t|p|nt)_[0-9a-f]{8,12}\b").expect("a pattern")
    });
    let mut rows: Vec<(String, String)> = Vec::new();
    for path in paths {
        let rel = path.strip_prefix(root).expect("below the root").to_string_lossy().into_owned();
        // the copies of a picture a browser drew
        if skip.iter().any(|m| m.contains(rel.rsplit('/').next().unwrap_or(&rel))) || rel.starts_with("scenario-pic") {
            continue;
        }
        let bytes = std::fs::read(&path).expect("a file");
        // a canvas file holds ids and times of its own: compared as the normalized JSON it is (its keys in order)
        let hashed = if rel.ends_with("canvas.json") {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let value: Value = serde_json::from_str(&text).expect("a canvas file");
            let mut seen: Vec<String> = Vec::new();
            let numbered = SHORT
                .replace_all(&value.to_string(), |c: &regex::Captures| {
                    let id = c[0].to_string();
                    let at = seen.iter().position(|s| *s == id).unwrap_or_else(|| {
                        seen.push(id.clone());
                        seen.len() - 1
                    });
                    format!("<{}:{}>", &c[1], at + 1)
                })
                .into_owned();
            normalize(&serde_json::from_str::<Value>(&numbered).expect("json")).to_string().into_bytes()
        } else {
            bytes
        };
        let hash: String = Sha256::digest(&hashed).iter().map(|b| format!("{b:02x}")).collect();
        let name = RANDOM.replace(&rel, "-<random>$1").into_owned();
        rows.push((name, hash));
    }
    rows.sort_by(|a, b| {
        (SHORT.replace_all(&a.0, "<x>").into_owned(), &a.1).cmp(&(SHORT.replace_all(&b.0, "<x>").into_owned(), &b.1))
    });
    rows.into_iter().map(|(rel, hash)| json!({"file": rel, "sha256": hash})).collect()
}

/// The tables to compare, normalized as one value so that an id is the same `<uuid:N>` in all of them.
fn tables(dump: &Value, uploads: Vec<Value>, folders: &[(String, &str)]) -> Map<String, Value> {
    let mut chosen = Map::new();
    let pages: std::collections::HashMap<String, String> = dump["docs_page"]
        .as_array()
        .expect("pages")
        .iter()
        .map(|p| (p["id"].as_str().unwrap_or_default().to_string(), format!("{}/{}", p["project_id"], p["slug"])))
        .collect();
    for (name, rows) in dump.as_object().expect("tables") {
        let wanted = ["docs_", "diagram", "sketch", "canvas", "notif"].iter().any(|p| name.starts_with(p))
            || ALSO.contains(&name.as_str());
        if wanted && !SKIP.contains(&name.as_str()) {
            let mut kept = stable(rows, &pages);
            // rows that differ only by the thread they point at cannot be put in an order both servers share: only
            // who read is compared
            if name == "docs_comment_read" {
                kept = kept.iter().map(|row| json!({"reader": row["reader"]})).collect();
            }
            chosen.insert(name.clone(), Value::Array(kept));
        }
    }
    chosen.insert("uploads".to_string(), Value::Array(uploads));
    let mut text = serde_json::to_string(&Value::Object(chosen)).expect("json");
    for (folder, name) in folders {
        text = text.replace(folder.as_str(), name);
    }
    let stored = regex::Regex::new(r"(/uploads/[A-Za-z0-9_.-]*?)-[0-9a-f]{6,12}(\.[a-z0-9]+)").expect("a pattern");
    let text = stored.replace_all(&text, "$1-<random>$2");
    let value: Value = serde_json::from_str(&text).expect("json");
    // the short ids, numbered by first appearance
    let short = regex::Regex::new(r"\b(dg|sk|cv|b|n|a|t|p|nt)_[0-9a-f]{8,12}\b").expect("a pattern");
    let mut seen: Vec<String> = Vec::new();
    let text = short
        .replace_all(&serde_json::to_string(&value).expect("json"), |c: &regex::Captures| {
            let id = c[0].to_string();
            let at = seen.iter().position(|s| *s == id).unwrap_or_else(|| {
                seen.push(id.clone());
                seen.len() - 1
            });
            format!("<{}:{}>", &c[1], at + 1)
        })
        .into_owned();
    normalize(&serde_json::from_str::<Value>(&text).expect("json")).as_object().expect("an object").clone()
}

#[tokio::test]
async fn docs_worked_through_mcp_leave_the_same_rows_as_python_does() {
    let s = common::start().await;
    let files = tempfile::Builder::new().prefix("kbfiles").tempdir().expect("a folder for the files");
    let skip = scenario(&s, files.path()).await;
    let dir = s.dir().to_string_lossy().into_owned();
    let mut folders = vec![(files.path().to_string_lossy().into_owned(), "<files>"), (dir.clone(), "<dir>")];
    if let Ok(real) = std::fs::canonicalize(&dir) {
        folders.push((real.to_string_lossy().into_owned(), "<dir>"));
    }
    if let Ok(real) = std::fs::canonicalize(files.path()) {
        folders.push((real.to_string_lossy().into_owned(), "<files>"));
    }
    folders.sort_by_key(|(folder, _)| std::cmp::Reverse(folder.len()));
    let uploads = uploaded(&s.uploads_dir(), &skip);
    let got = tables(&s.dump_db().await, uploads, &folders);

    if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        assert_eq!(target(), Target::Python, "the golden file is what the Python server stores");
        std::fs::write(GOLDEN, serde_json::to_string_pretty(&got).expect("json") + "\n")
            .expect("write the golden file");
    }
    let golden: Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(GOLDEN).expect("the golden file")).expect("it parses");
    assert_eq!(got.keys().collect::<Vec<_>>(), golden.keys().collect::<Vec<_>>(), "the tables compared");
    assert!(got["docs_page"].as_array().expect("rows").len() >= 8, "the pages");
    for (table, expected) in &golden {
        let (got, expected) = (got[table].as_array().expect("rows"), expected.as_array().expect("rows"));
        assert_eq!(got.len(), expected.len(), "{table}: the number of rows");
        for (got, expected) in got.iter().zip(expected) {
            assert_eq!(got, expected, "{table}");
        }
    }
}
