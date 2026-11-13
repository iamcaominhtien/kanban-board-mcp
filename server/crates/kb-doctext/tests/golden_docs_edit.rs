//! Every function of `services/docs_edit.py` against the vectors Python made (`contract/golden/docs_edit.json`).

mod common;

use common::{error, os, s, strings, u};
use kb_doctext::docs_edit::{self, Edit, EditError};
use serde_json::{Value, json};

fn result<T: serde::Serialize>(r: Result<T, EditError>) -> Value {
    match r {
        Ok(v) => serde_json::to_value(v).unwrap_or(Value::Null),
        Err(EditError(message)) => error("EditError", &message),
    }
}

fn edit_of(v: &Value) -> Edit {
    let get = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Edit { markdown: get("markdown"), mode: get("mode"), section: get("section"), find: get("find") }
}

#[test]
fn golden_docs_edit() {
    common::run("docs_edit.json", |name, a| match name {
        "key" => json!(docs_edit::key(s(&a[0]))),
        "block" => json!(docs_edit::block(s(&a[0]))),
        "join" => json!(docs_edit::join(&strings(&a[0]))),
        "splice" => json!(docs_edit::splice(&strings(&a[0]), u(&a[1]), u(&a[2]), strings(&a[3]))),
        "sections" => serde_json::to_value(docs_edit::sections(s(&a[0]))).unwrap_or(Value::Null),
        "find_section" => result(docs_edit::find_section(s(&a[0]), s(&a[1]))),
        "section_text" => result(docs_edit::section_text(s(&a[0]), s(&a[1]))),
        "edit_section" => result(docs_edit::edit_section(s(&a[0]), s(&a[1]), s(&a[2]), s(&a[3]))),
        "edit_passage" => result(docs_edit::edit_passage(s(&a[0]), s(&a[1]), s(&a[2]), s(&a[3]))),
        "append_page" => json!(docs_edit::append_page(s(&a[0]), s(&a[1]))),
        "apply" => result(docs_edit::apply(s(&a[0]), &edit_of(&a[1]), os(&a[2]))),
        other => panic!("golden function {other} is not handled"),
    });
}
