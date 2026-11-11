//! Shared by the golden tests: load a vector file made by `contract/golden/gen_docs_text.py` and compare every case.

#![allow(dead_code)]

use serde_json::{Value, json};

/// Path of a file under `contract/golden/`.
pub fn golden_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/golden").join(name)
}

/// Load `contract/golden/<name>`.
pub fn load(name: &str) -> Value {
    let path = golden_path(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display()))
}

pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("a string was expected, got {v}"))
}

pub fn u(v: &Value) -> usize {
    v.as_u64().unwrap_or_else(|| panic!("a non-negative integer was expected, got {v}")) as usize
}

pub fn os(v: &Value) -> Option<&str> {
    if v.is_null() { None } else { Some(s(v)) }
}

pub fn strings(v: &Value) -> Vec<String> {
    v.as_array().expect("a list").iter().map(|x| s(x).to_string()).collect()
}

/// `{"error": {...}}` as a failed case is recorded.
pub fn error(kind: &str, message: &str) -> Value {
    json!({"error": {"type": kind, "message": message}})
}

/// Run every case of `functions` through `dispatch(name, args)`, which returns the Rust result as the JSON the
/// Python result serializes to. Every function of the file must be handled, and every case must pass.
pub fn run(file: &str, dispatch: impl Fn(&str, &[Value]) -> Value) {
    let data = load(file);
    let functions = data["functions"].as_object().expect("functions");
    let mut failures: Vec<String> = Vec::new();
    let mut total = 0;
    for (name, cases) in functions {
        let cases = cases.as_array().expect("cases");
        assert!(!cases.is_empty(), "{file}: no cases for {name}");
        let mut bad = 0;
        for case in cases {
            total += 1;
            let args = case["args"].as_array().expect("args");
            let expected = match case.get("error") {
                Some(err) => json!({ "error": err }),
                None => case["result"].clone(),
            };
            let got = dispatch(name, args);
            if got != expected {
                bad += 1;
                if failures.len() < 12 {
                    let mut shown = Value::Array(args.clone()).to_string();
                    shown.truncate(600);
                    failures.push(format!(
                        "{name}({shown})\n   python: {}\n   rust:   {}",
                        short(&expected),
                        short(&got)
                    ));
                }
            }
        }
        println!("{file}: {name}: {}/{} cases equal", cases.len() - bad, cases.len());
    }
    println!("{file}: {total} cases");
    assert!(failures.is_empty(), "{} failures (first ones):\n{}", failures.len(), failures.join("\n"));
}

fn short(v: &Value) -> String {
    let mut text = v.to_string();
    if text.len() > 700 {
        let mut cut = 700;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("...");
    }
    text
}
