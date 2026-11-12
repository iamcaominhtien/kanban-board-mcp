//! `contract/golden/diagram_model.json`: what the Python `diagram_model`, the XML reader behind it and the pure
//! functions of `diagrams` gave for each case (made by `contract/golden/gen_diagram_model.py`).

use kb_doctext::docs_text::DocsError;
use kb_draw::diagram_model::{self, Error};
use kb_draw::xml::{self, Element};
use kb_draw::{diagrams, html};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/diagram_model.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("golden file")).expect("golden json")
}

/// A Python result record: `{"ok": value}` or `{"error": {...}}`.
fn check(name: &str, what: &str, want: &Value, got: Result<Value, Error>) {
    match (want.get("ok"), want.get("error")) {
        (Some(ok), _) => {
            let got = got.unwrap_or_else(|e| panic!("{name}: {what}: expected a value, got the error {e}"));
            assert_eq!(&got, ok, "{name}: {what}");
        }
        (_, Some(err)) => {
            let got = match got {
                Ok(v) => panic!("{name}: {what}: expected the error {err}, got {v}"),
                Err(e) => e,
            };
            let kind = err["type"].as_str().unwrap_or("");
            match got {
                Error::Docs(d) => {
                    assert_eq!(kind, "DocsError", "{name}: {what}: {d}");
                    assert_eq!(json!(d.status), err["status"], "{name}: {what}");
                    assert_eq!(json!(d.code), err["code"], "{name}: {what}");
                    assert_eq!(json!(d.message), err["message"], "{name}: {what}");
                    assert_eq!(Value::Object(d.extra), err["extra"], "{name}: {what}");
                }
                Error::Value(m) => {
                    assert_eq!(kind, "ValueError", "{name}: {what}: {m}");
                    assert_eq!(json!(m), err["message"], "{name}: {what}");
                }
            }
        }
        _ => panic!("{name}: {what}: bad record {want}"),
    }
}

fn docs(r: Result<Value, DocsError>) -> Result<Value, Error> {
    r.map_err(Error::Docs)
}

#[test]
fn cases_give_what_python_gives() {
    let data = golden();
    let cases = data["cases"].as_array().expect("cases");
    assert!(cases.len() > 60);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let source = case["source"].as_str().expect("source");
        check(name, "model", &case["model"], diagram_model::model(source, 300).map(Value::Object));
        check(name, "model(limit=2)", &case["model_limit_2"], diagram_model::model(source, 2).map(Value::Object));
        check(name, "render_svg", &case["render_svg"], diagram_model::render_svg(source).map(Value::String));
        assert_eq!(
            diagram_model::uncompressed(source),
            case["uncompressed"].as_str().expect("uncompressed"),
            "{name}: uncompressed"
        );
        check(name, "sanitize_svg", &case["sanitize_svg"], docs(diagrams::sanitize_svg(source).map(Value::String)));
        check(
            name,
            "validate_source",
            &case["validate_source"],
            docs(diagrams::validate_source(source).map(|r| Value::String(r.tag))),
        );
        check(
            name,
            "text_summary",
            &case["text_summary"],
            docs(diagrams::validate_source(source).map(|r| Value::String(diagrams::text_summary(&r, 12)))),
        );
        check(
            name,
            "is_empty",
            &case["is_empty"],
            docs(diagrams::validate_source(source).map(|r| Value::Bool(diagrams::is_empty(&r)))),
        );
    }
}

#[test]
fn svg_cases_are_sanitized_the_same() {
    for case in golden()["svg_cases"].as_array().expect("svg cases") {
        let name = case["name"].as_str().expect("name");
        let svg = case["svg"].as_str().expect("svg");
        check(name, "sanitize_svg", &case["sanitize_svg"], docs(diagrams::sanitize_svg(svg).map(Value::String)));
    }
}

fn tree(el: &Element) -> Value {
    json!({
        "tag": el.tag,
        "attrib": el.attrib.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
        "text": el.text,
        "tail": el.tail,
        "children": el.children.iter().map(tree).collect::<Vec<_>>(),
    })
}

#[test]
fn the_xml_reader_reads_and_fails_as_expat_does() {
    let mut off = Vec::new();
    for case in golden()["xml"].as_array().expect("xml cases") {
        let source = case["source"].as_str().expect("source");
        match (xml::fromstring(source), case.get("error"), case.get("tree")) {
            (Err(e), Some(want), _) => {
                if e.to_string() != want.as_str().unwrap_or("") {
                    off.push(format!("{source:?}: want {want}, got {e}"));
                }
            }
            (Ok(root), None, Some(want)) => {
                assert_eq!(&tree(&root), want, "{source:?}");
                assert_eq!(json!(xml::tostring(&root, &diagram_model::REGISTERED_NAMESPACES)), case["tostring"], "{source:?}: tostring");
            }
            (Ok(_), Some(want), _) => off.push(format!("{source:?}: want the error {want}, got a tree")),
            (Err(e), None, _) => off.push(format!("{source:?}: want a tree, got {e}")),
            _ => panic!("bad record"),
        }
    }
    assert!(off.is_empty(), "{} differences:\n{}", off.len(), off.join("\n"));
}

#[test]
fn the_xml_writer_follows_elementtree() {
    for case in golden()["xml_write"].as_array().expect("xml_write") {
        let source = case["source"].as_str().expect("source");
        let root = xml::fromstring(source).expect("parses");
        assert_eq!(json!(xml::tostring(&root, &diagram_model::REGISTERED_NAMESPACES)), case["tostring"], "{source:?}");
    }
}

#[test]
fn small_helpers_match() {
    let h = &golden()["helpers"];
    for row in h["unquote"].as_array().expect("unquote") {
        assert_eq!(json!(diagram_model::unquote(row[0].as_str().unwrap_or(""))), row[1], "unquote {row}");
    }
    for row in h["float"].as_array().expect("float") {
        let got = diagram_model::py_float(row[0].as_str().unwrap_or(""));
        match row[1].get("ok").and_then(Value::as_str) {
            Some(repr) => {
                let want = match repr {
                    "inf" => f64::INFINITY,
                    "-inf" => f64::NEG_INFINITY,
                    "nan" => f64::NAN,
                    other => other.parse::<f64>().expect("python repr parses"),
                };
                let got = got.unwrap_or_else(|e| panic!("float {row}: {e}"));
                assert!(got == want || (got.is_nan() && want.is_nan()), "float {row}: got {got}");
            }
            None => {
                let want = row[1]["error"]["message"].as_str().unwrap_or("");
                assert_eq!(got.expect_err(&format!("float {row}")), want, "float {row}");
            }
        }
    }
    for row in h["unescape"].as_array().expect("unescape") {
        assert_eq!(json!(html::unescape(row[0].as_str().unwrap_or(""))), row[1], "unescape {row}");
    }
    for row in h["plain"].as_array().expect("plain") {
        assert_eq!(json!(diagram_model::plain(row[0].as_str().unwrap_or(""))), row[1], "plain {row}");
    }
    for row in h["style_get"].as_array().expect("style_get") {
        let got = diagram_model::style_get(row[0].as_str().unwrap_or(""), row[1].as_str().unwrap_or(""));
        assert_eq!(json!(got), row[2], "style_get {row}");
    }
    for row in h["b64"].as_array().expect("b64") {
        let got = diagram_model::b64decode(row[0].as_str().unwrap_or(""));
        match row[1].get("ok").and_then(Value::as_str) {
            Some(hex) => {
                let got = got.unwrap_or_else(|| panic!("b64 {row}: error"));
                let hexed: String = got.iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(hexed, hex, "b64 {row}");
            }
            None => assert!(got.is_none(), "b64 {row}: expected an error"),
        }
    }
    for row in h["round1"].as_array().expect("round1") {
        assert_eq!(json!(diagram_model::round1(row[0].as_f64().unwrap_or(0.0))), row[1], "round1 {row}");
    }
    for row in h["fmt_g"].as_array().expect("fmt_g") {
        assert_eq!(json!(diagram_model::fmt_g(row[0].as_f64().unwrap_or(0.0))), row[1], "fmt_g {row}");
    }
    for row in h["fmt_f"].as_array().expect("fmt_f") {
        let v = row[0].as_f64().unwrap_or(0.0);
        assert_eq!(json!(format!("{v:.1}")), row[1], "fmt .1f {row}");
        assert_eq!(json!(format!("{v:.0}")), row[2], "fmt .0f {row}");
    }
    for row in h["label"].as_array().expect("label") {
        assert_eq!(json!(diagrams::label(row[0].as_str())), row[1], "label {row}");
    }
    for row in h["refs_in"].as_array().expect("refs_in") {
        assert_eq!(json!(diagrams::refs_in(row[0].as_str().unwrap_or(""))), row[1], "refs_in {row}");
    }
    for row in h["parse_pins"].as_array().expect("parse_pins") {
        let got: Map<String, Value> = diagrams::parse_pins(row[0].as_str());
        assert_eq!(Value::Object(got), row[1], "parse_pins {row}");
    }
    for row in h["forbid_dtd"].as_array().expect("forbid_dtd") {
        let got = diagrams::forbid_dtd(row[0].as_str().unwrap_or(""), "diagram file");
        match (&got, row[1].get("error")) {
            (Err(e), Some(want)) => assert_eq!(json!(e.message), want["message"], "forbid_dtd {row}"),
            (Ok(()), None) => {}
            _ => panic!("forbid_dtd {row}: got {got:?}"),
        }
    }
}
