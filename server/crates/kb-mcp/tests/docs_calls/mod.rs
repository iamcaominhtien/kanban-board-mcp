//! The Docs tools, call by call: `docs_read` and `docs_write`, every action, with realistic arguments and every error
//! branch, answered by the Python server (recorded in `contract/golden/mcp_tool_calls_docs_*.json`) and by the Rust
//! server. One file per area: pages (with versions, search, links, the bin, import, upload, tickets), comments,
//! drawings (diagrams, sketches, pictures), canvases and the guides.
//!
//! Files are made in a folder of the test; what a result says about it (paths) is normalized, and the files a tool
//! writes are compared by their SHA-256. A picture a browser drew is only compared by its size: two browsers' pixels
//! are not the contract. To record the files again:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_tool_calls docs_`.

use std::path::Path;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use testkit::normalize;

use super::{Call, Run, call, check_golden, keep, keep_at, scrub};

mod canvases;
mod comments;
mod drawings;
mod guides;
mod pages;

/// `docs_read(action=..., **rest)`.
pub fn dr(name: &'static str, action: &str, rest: Value) -> Call {
    call(name, "docs_read", with_action(action, rest))
}

/// `docs_write(action=..., **rest)`.
pub fn dw(name: &'static str, action: &str, rest: Value) -> Call {
    call(name, "docs_write", with_action(action, rest))
}

/// `docs_write` that keeps the `id` of its result.
pub fn dwk(name: &'static str, action: &str, rest: Value, keep_as: &'static str) -> Call {
    keep(name, "docs_write", with_action(action, rest), keep_as)
}

/// `docs_write` that keeps the value at `pointer` of its result.
pub fn dwp(name: &'static str, action: &str, rest: Value, keep_as: &'static str, pointer: &'static str) -> Call {
    keep_at(name, "docs_write", with_action(action, rest), keep_as, pointer)
}

fn with_action(action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    arguments
}

/// The ids of the drawings and canvases (`dg_`, `sk_`, `cv_`, `b_`... and eight hex digits) are numbered by first
/// appearance, as the normalizer numbers UUIDs: they differ from one run to the next.
pub fn number_short_ids(value: &Value) -> Value {
    static SHORT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\b(dg|sk|cv|b|n|a|t|p)_[0-9a-f]{8}\b").expect("a pattern"));
    fn walk(value: &Value, seen: &mut Vec<String>) -> Value {
        let number = |text: &str, seen: &mut Vec<String>| {
            SHORT
                .replace_all(text, |c: &regex::Captures| {
                    let id = c[0].to_string();
                    let at = seen.iter().position(|s| *s == id).unwrap_or_else(|| {
                        seen.push(id.clone());
                        seen.len() - 1
                    });
                    format!("<{}:{}>", &c[1], at + 1)
                })
                .into_owned()
        };
        match value {
            Value::String(text) => Value::String(number(text, seen)),
            Value::Array(items) => Value::Array(items.iter().map(|v| walk(v, seen)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (number(k, seen), walk(v, seen))).collect()),
            other => other.clone(),
        }
    }
    walk(value, &mut Vec::new())
}

/// The hex SHA-256 of a file, or null when there is none.
pub fn sha256_of(path: &str) -> Value {
    match std::fs::read(path) {
        Ok(bytes) => json!(
            Digest::finalize(Sha256::new().chain_update(&bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>()
        ),
        Err(_) => Value::Null,
    }
}

/// What a result names as a file it wrote (`path`, `png_path`, `source_path`) and whether it is compared by its
/// bytes: a picture a browser drew is not.
fn written_files(result: &Value) -> Vec<(String, bool)> {
    let Some(text) = result["content"][0]["text"].as_str() else { return Vec::new() };
    let Ok(Value::Object(out)) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let by_bytes = out.get("drawn_by").and_then(Value::as_str) != Some("browser");
    let written = out
        .get("board")
        .and_then(|b| b.get("written"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    ["path", "png_path", "source_path"]
        .iter()
        .filter_map(|k| out.get(*k).and_then(Value::as_str))
        .chain(written)
        .filter(|p| Path::new(p).is_file())
        .map(|p| (p.to_string(), by_bytes))
        .collect()
}

/// Run the calls, and record next to each the SHA-256 of the files it wrote.
pub async fn run_with_files(run: &mut Run, calls: Vec<Call>) {
    for one in calls {
        let name = one.name;
        run.run(vec![one]).await;
        let reply = run.got[name].clone();
        for (i, (path, by_bytes)) in written_files(&reply).into_iter().enumerate() {
            let key = format!("{name} [file {}]", i + 1);
            let hash = if by_bytes { sha256_of(&path) } else { json!("<not compared>") };
            run.got.insert(
                key,
                json!({"sha256": hash, "name": Path::new(&path).file_name().map(|n| n.to_string_lossy())}),
            );
        }
    }
}

/// The files the calls name, made in a folder of this test.
pub struct Fixtures {
    pub dir: tempfile::TempDir,
}

/// A valid 1 x 1 PNG.
pub const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0xf8, 0x0f, 0x00, 0x01, 0x04, 0x01, 0x00, 0xc1, 0x2d, 0x8e,
    0x50, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/// A small draw.io file: one box per label, an arrow from each to the next.
pub fn drawio(labels: &[&str], extra: &str) -> String {
    let cells: String = labels
        .iter()
        .enumerate()
        .map(|(i, label)| {
            format!(
                "<mxCell id=\"n{i}\" value=\"{label}\" style=\"rounded=1;fillColor=#E6F2EA;\" vertex=\"1\" parent=\"1\">\
                 <mxGeometry x=\"{}\" y=\"40\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell>",
                40 + 160 * i
            )
        })
        .collect();
    let edges: String = (0..labels.len().saturating_sub(1))
        .map(|i| {
            format!(
                "<mxCell id=\"e{i}\" value=\"{}\" style=\"endArrow=classic;\" edge=\"1\" parent=\"1\" source=\"n{i}\" target=\"n{}\">\
                 <mxGeometry relative=\"1\" as=\"geometry\"/></mxCell>",
                if i == 0 { "yes" } else { "" },
                i + 1
            )
        })
        .collect();
    format!(
        "<mxfile><diagram name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>{cells}{edges}{extra}</root></mxGraphModel></diagram></mxfile>"
    )
}

impl Fixtures {
    pub fn new() -> Self {
        let dir = tempfile::Builder::new().prefix("kbdocs").tempdir().expect("a folder for the files");
        let f = Fixtures { dir };
        // the Markdown to import: a folder, a file with a front matter, and files that are not Markdown
        f.write("import/guide/intro.md", "# Intro\nSee [[Limits]].\n");
        f.write("import/guide/deep/more.markdown", "# More\nDeeper.\n");
        f.write("import/notes.md", "---\ntitle: Notes\n---\nhello\n");
        f.write("import/skip.txt", "no");
        f.write("single.md", "# Single\nOne file.\n");
        f.write("empty/.keep", "");
        f.write("pic.png", "");
        std::fs::write(f.path("pic.png"), PNG).expect("a picture");
        f.write("notes.txt", "stack trace\nline 2\n");
        f.write("secret.pem", "-----BEGIN PRIVATE KEY-----");
        f.write("flow.drawio", &drawio(&["Client", "API gateway", "Service"], ""));
        f.write("flow.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"100\"><rect width=\"200\" height=\"100\" fill=\"#cfe\"/></svg>");
        f.write("broken.drawio", "this is not xml");
        f.write(
            "lonely.drawio",
            &drawio(&["Alone", "Another"], "").replace("source=\"n0\" target=\"n1\"", "source=\"n0\" target=\"zz\""),
        );
        std::fs::write(f.path("dot.png"), PNG).expect("a picture");
        f.write(
            "dot.sketch.json",
            &json!({"format": "kanban-sketch", "version": 1, "width": 1, "height": 1,
                    "layers": [{"id": "l1", "name": "Layer 1", "kind": "draw", "visible": true, "opacity": 1, "data": ""}]})
            .to_string(),
        );
        f.write("bad.sketch.json", "{\"format\": \"other\"}");
        f.write("not.png", "plain text");
        // a canvas: a frame per sub-folder, one with its own settings, and a layout
        f.write(
            "canvas/01-home/index.html",
            "<!doctype html><title>Home</title><h1>Home</h1><button id=\"go\">Go</button><p>Welcome</p>",
        );
        f.write("canvas/01-home/style.css", "h1{color:#2e6f40}");
        f.write(
            "canvas/01-home/frame.json",
            &json!({"name": "Home screen", "size": "phone", "page": "Screens"}).to_string(),
        );
        f.write("canvas/02-detail/index.html", "<!doctype html><title>Detail</title><h1>Detail</h1><p>Text</p>");
        f.write(
            "canvas/02-detail/frame.json",
            &json!({"size": [820, 600], "page": "Screens", "fit": true}).to_string(),
        );
        f.write("canvas/03-notes/index.html", "<!doctype html><title>Notes</title><p>Plain</p>");
        f.write(
            "canvas/canvas.json",
            &json!({"notes": [{"id": "n1", "text": "Check the empty state", "near": "01-home", "color": "green"},
                              {"text": "Loose note", "x": 10, "y": 20, "page": "Screens"}],
                    "arrows": [{"from": "01-home", "to": "02-detail", "label": "tap"}, {"from": "n1", "to": "02-detail"}],
                    "labels": [{"text": "Flow A", "page": "Screens"}]})
            .to_string(),
        );
        f.write("flat/index.html", "<!doctype html><title>Flat</title><p>One page at the top</p>");
        f.write("flat/app.js", "console.log(1)");
        f.write("nopage/readme.txt", "no html here");
        f.write("badlayout/a/index.html", "<p>a</p>");
        f.write("badlayout/canvas.json", &json!({"notes": [{"text": "x", "near": "zzz"}]}).to_string());
        f.write("badarrow/a/index.html", "<p>a</p>");
        f.write("badarrow/canvas.json", &json!({"arrows": [{"from": "a", "to": "nowhere"}]}).to_string());
        f.write("badjson/a/index.html", "<p>a</p>");
        f.write("badjson/canvas.json", "{not json");
        f.write("badjson/a/frame.json", "[1, 2]");
        f.write("edit/index.html", "<!doctype html><title>Home v2</title><h1>Home v2</h1>");
        f.write("edit/extra.css", "p{margin:0}");
        f
    }

    pub fn path(&self, rel: &str) -> String {
        self.dir.path().join(rel).to_string_lossy().into_owned()
    }

    pub fn write(&self, rel: &str, text: &str) {
        let path = self.dir.path().join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a folder");
        std::fs::write(path, text).expect("a file");
    }

    /// The folders of this run that a result may print, longest first.
    pub fn folders(&self, extra: &[(String, &'static str)]) -> Vec<(String, &'static str)> {
        let mut folders = Vec::new();
        let root = self.dir.path().to_string_lossy().into_owned();
        folders.push((root.clone(), "<files>"));
        if let Ok(real) = std::fs::canonicalize(&root) {
            folders.push((real.to_string_lossy().into_owned(), "<files>"));
        }
        folders.extend(extra.iter().cloned());
        folders.sort_by_key(|(folder, _)| std::cmp::Reverse(folder.len()));
        folders
    }
}

/// The result of a run, normalized, as the object a golden file holds.
pub fn finish(run: Run, folders: &[(String, &str)]) -> Map<String, Value> {
    let scrubbed = scrub(&Value::Object(run.got), folders);
    let normalized = normalize(&number_short_ids(&scrubbed));
    normalized.as_object().expect("an object").clone()
}

pub fn golden(name: &str, got: &Map<String, Value>) {
    let size = serde_json::to_string_pretty(got).expect("json").len();
    assert!(size < 2 * 1024 * 1024, "{name}: {size} bytes, over 2 MB");
    check_golden(name, got);
}
