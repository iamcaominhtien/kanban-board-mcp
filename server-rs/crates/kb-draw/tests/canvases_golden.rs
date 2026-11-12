//! The pure helpers of `canvases` against what `services/canvases.py` computes for the same inputs
//! (`contract/golden/gen_canvases.py`).

use base64::Engine;
use kb_base::pyjson;
use kb_doctext::docs_text::DocsError;
use kb_draw::canvases::{self, archive, content, save, textdiff, versions};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/canvases.json");
    serde_json::from_slice(&std::fs::read(path).expect("golden file")).expect("golden json")
}

fn bytes(v: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(v.as_str().expect("base64")).expect("base64")
}

fn text(v: &Value) -> String {
    pyjson::dumps(v)
}

/// A `{ok}` or `{error}` of the generator, as the Rust result gives it.
fn outcome<T>(r: Result<T, DocsError>, ok: impl Fn(T) -> Value) -> Value {
    match r {
        Ok(v) => json!({"ok": ok(v)}),
        Err(e) => {
            json!({"error": {"status": e.status, "code": e.code, "message": e.message, "extra": Value::Object(e.extra)}})
        }
    }
}

fn check(what: &str, got: &Value, want: &Value, bad: &mut Vec<String>) {
    if text(got) != text(want) {
        bad.push(format!("{what}\n  got  {}\n  want {}", text(got), text(want)));
    }
}

fn report(name: &str, bad: Vec<String>) {
    assert!(
        bad.is_empty(),
        "{name}: {} differ:\n{}",
        bad.len(),
        bad.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn num_keeps_a_number_between_bounds_as_python_does() {
    let mut bad = Vec::new();
    for c in golden()["nums"].as_array().expect("nums") {
        let got = canvases::num(
            Some(&c["value"]),
            &c["default"],
            c["lo"].as_i64().expect("lo"),
            c["hi"].as_i64().expect("hi"),
        );
        check(&format!("num({}, {}, {}, {})", c["value"], c["default"], c["lo"], c["hi"]), &got, &c["ok"], &mut bad);
    }
    report("num", bad);
}

#[test]
fn text_drops_control_characters_and_cuts() {
    let mut bad = Vec::new();
    for c in golden()["texts"].as_array().expect("texts") {
        let got = json!(canvases::text(Some(&c["value"]), c["limit"].as_u64().expect("limit") as usize));
        check(&format!("text({}, {})", c["value"], c["limit"]), &got, &c["out"], &mut bad);
    }
    report("text", bad);
}

#[test]
fn safe_path_refuses_what_leaves_a_folder() {
    let mut bad = Vec::new();
    for c in golden()["paths"].as_array().expect("paths") {
        let got = outcome(canvases::safe_path(c["raw"].as_str().expect("raw")), |p| json!(p));
        check(
            &format!("safe_path({})", c["raw"]),
            &got,
            &json!({"ok": c["ok"], "error": c["error"]})
                .as_object()
                .map(|m| {
                    let mut m = m.clone();
                    m.retain(|_, v| !v.is_null());
                    Value::Object(m)
                })
                .expect("object"),
            &mut bad,
        );
    }
    report("safe_path", bad);
}

#[test]
fn picture_sizes_and_kinds_are_read_from_the_header() {
    let mut bad = Vec::new();
    for c in golden()["pictures"].as_array().expect("pictures") {
        let data = bytes(&c["data"]);
        let magic = content::magic_image(&data).map_or(Value::Null, |m| json!(m));
        let size = content::image_size(&data).map_or(Value::Null, |(w, h)| json!([w, h]));
        check(&format!("magic {}", c["data"]), &magic, &c["magic"], &mut bad);
        check(&format!("size {}", c["data"]), &size, &c["size"], &mut bad);
    }
    report("pictures", bad);
}

fn files_of(v: &Value) -> content::Files {
    v.as_object()
        .expect("files")
        .iter()
        .map(|(k, v)| match v.as_object() {
            Some(fill) => (
                k.clone(),
                vec![fill["fill"].as_str().expect("fill").as_bytes()[0]; fill["n"].as_u64().expect("n") as usize],
            ),
            None => (k.clone(), bytes(v)),
        })
        .collect()
}

#[test]
fn prepare_files_checks_the_files_of_a_frame() {
    let mut bad = Vec::new();
    for c in golden()["prepares"].as_array().expect("prepares") {
        let files = files_of(&c["files"]);
        let got = outcome(content::prepare_files(&files, c["entry"].as_str()), |(clean, info)| {
            let mut names: Vec<String> = clean.into_iter().map(|(n, _)| n).collect();
            names.sort();
            json!({"info": Value::Object(info), "files": names})
        });
        let want = if c["ok"].is_null() { json!({"error": c["error"]}) } else { json!({"ok": c["ok"]}) };
        check(
            &format!(
                "prepare_files({}, {})",
                c["files"].as_object().map(|m| m.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default(),
                c["entry"]
            ),
            &got,
            &want,
            &mut bad,
        );
    }
    report("prepare_files", bad);
}

#[test]
fn roots_and_slugs() {
    let g = golden();
    let mut bad = Vec::new();
    for c in g["roots"].as_array().expect("roots") {
        let out: Vec<String> = {
            let mut v: Vec<String> =
                archive::strip_common_root(files_of(&c["files"])).into_iter().map(|(n, _)| n).collect();
            v.sort();
            v
        };
        check("strip_common_root", &json!(out), &c["out"], &mut bad);
    }
    for c in g["slugs"].as_array().expect("slugs") {
        let got = json!(archive::slug(c["text"].as_str().expect("text"), c["fallback"].as_str().expect("fallback")));
        check(&format!("slug({})", c["text"]), &got, &c["out"], &mut bad);
    }
    report("roots and slugs", bad);
}

fn obj(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

#[test]
fn clean_fields_of_a_board_note_label_and_arrow() {
    let mut bad = Vec::new();
    for c in golden()["cleans"].as_array().expect("cleans") {
        let src = obj(&c["src"]).expect("src");
        let old = obj(&c["old"]);
        let actor = c["actor"].as_str().expect("actor");
        let what = format!("src {} old {} actor {actor:?}", c["src"], c["old"]);
        check(&format!("board {what}"), &Value::Object(canvases::clean_board_layout(src, old)), &c["board"], &mut bad);
        check(&format!("note {what}"), &Value::Object(canvases::clean_note(src, old, actor)), &c["note"], &mut bad);
        check(&format!("label {what}"), &Value::Object(canvases::clean_label(src, old)), &c["label"], &mut bad);
        check(&format!("arrow {what}"), &Value::Object(canvases::clean_arrow(src, old)), &c["arrow"], &mut bad);
    }
    report("clean", bad);
}

#[test]
fn names_embed_lines_and_references() {
    let g = golden();
    let mut bad = Vec::new();
    for c in g["names"].as_array().expect("names") {
        let title = c["title"].as_str();
        check("canvas_name", &json!(canvases::canvas_name(title, "Canvas")), &c["name"], &mut bad);
        check("embed", &json!(canvases::embed_line("cv_8f3a1c2d", title.unwrap_or(""), None)), &c["embed"], &mut bad);
        check(
            "embed_b",
            &json!(canvases::embed_line("cv_8f3a1c2d", title.unwrap_or(""), Some("b_0a1b2c3d"))),
            &c["embed_b"],
            &mut bad,
        );
    }
    for c in g["refs"].as_array().expect("refs") {
        check("refs_in", &json!(canvases::refs_in(c["text"].as_str().expect("text"))), &c["out"], &mut bad);
    }
    report("names", bad);
}

#[test]
fn unified_diff_is_difflibs() {
    let mut bad = Vec::new();
    for (i, c) in golden()["diffs"].as_array().expect("diffs").iter().enumerate() {
        let lines = |v: &Value| -> Vec<String> {
            v.as_array().expect("lines").iter().map(|l| l.as_str().expect("line").to_string()).collect()
        };
        let (a, b) = (lines(&c["a"]), lines(&c["b"]));
        let (ra, rb): (Vec<&str>, Vec<&str>) =
            (a.iter().map(String::as_str).collect(), b.iter().map(String::as_str).collect());
        let got = json!(textdiff::unified_diff(&ra, &rb, "v1/x", "v2/x", 2));
        check(&format!("diff {i} ({} and {} lines)", a.len(), b.len()), &got, &c["out"], &mut bad);
    }
    report("diffs", bad);
}

#[test]
fn diff_docs_and_describe_changes() {
    let mut bad = Vec::new();
    for c in golden()["docs"].as_array().expect("docs") {
        let new = obj(&c["new"]).expect("new");
        let ch = versions::diff_docs(obj(&c["old"]), new);
        check(&format!("diff_docs {}", c["label"]), &ch, &c["changes"], &mut bad);
        let names: Vec<(String, String)> = c["names"]
            .as_object()
            .expect("names")
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
            .collect();
        check(
            &format!("describe {}", c["label"]),
            &json!(versions::describe_changes(&ch, &names)),
            &c["describe"],
            &mut bad,
        );
    }
    report("docs", bad);
}

#[test]
fn free_spot_and_check_doc() {
    let g = golden();
    let mut bad = Vec::new();
    for c in g["spots"].as_array().expect("spots") {
        let mut doc = Map::new();
        doc.insert("boards".into(), c["boards"].clone());
        let (x, y) = content::free_spot(&doc, &c["page"], c["w"].as_f64().expect("w"), c["h"].as_f64().expect("h"));
        let want = c["out"].as_array().expect("out");
        let same = want[0].as_f64() == Some(x) && want[1].as_f64() == Some(y);
        if !same {
            bad.push(format!("free_spot {} {} -> ({x}, {y}) want {}", c["boards"], c["page"], c["out"]));
        }
    }
    for c in g["checks"].as_array().expect("checks") {
        let mut doc = obj(&c["doc"]).expect("doc").clone();
        let got = outcome(save::check_doc(&mut doc), |()| Value::Object(doc.clone()));
        let got = match got.get("ok") {
            Some(_) => json!({"ok": Value::Object(doc.clone())}),
            None => got,
        };
        check(
            "check_doc",
            &got,
            &if c["ok"].is_null() { json!({"error": c["error"]}) } else { json!({"ok": c["ok"]}) },
            &mut bad,
        );
    }
    report("free_spot and check_doc", bad);
}
