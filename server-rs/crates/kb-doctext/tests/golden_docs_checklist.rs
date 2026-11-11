//! Every function of `services/docs_checklist.py` against the vectors Python made
//! (`contract/golden/docs_checklist.json`).

mod common;

use common::{os, s};
use kb_doctext::docs_checklist;
use serde_json::{Value, json};

#[test]
fn golden_docs_checklist() {
    common::run("docs_checklist.json", |name, a| match name {
        "line_text" => json!(docs_checklist::line_text(s(&a[0]))),
        "clean_title" => json!(docs_checklist::clean_title(s(&a[0]))),
        "extract" => {
            let selection = a.get(1).and_then(os);
            serde_json::to_value(docs_checklist::extract(s(&a[0]), selection)).unwrap_or(Value::Null)
        }
        other => panic!("golden function {other} is not handled"),
    });
}
