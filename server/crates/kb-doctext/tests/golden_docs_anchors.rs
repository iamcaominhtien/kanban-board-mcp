//! Every function of `services/docs_anchors.py` against the vectors Python made (`contract/golden/docs_anchors.json`).

mod common;

use common::{os, s, u};
use kb_doctext::docs_anchors::{self, Block};
use serde_json::{Value, json};

#[test]
fn golden_docs_anchors() {
    common::run("docs_anchors.json", |name, a| match name {
        "normalize" => json!(docs_anchors::normalize(s(&a[0]))),
        "blocks_of" => serde_json::to_value(docs_anchors::blocks_of(s(&a[0]))).unwrap_or(Value::Null),
        "context_of" => {
            let (before, after) = docs_anchors::context_of(s(&a[0]), u(&a[1]), u(&a[2]));
            json!([before, after])
        }
        "find_anchor" => {
            let blocks: Vec<Block> = serde_json::from_value(a[0].clone()).expect("blocks");
            let found = docs_anchors::find_anchor(&blocks, s(&a[1]), s(&a[2]), s(&a[3]), os(&a[4]));
            serde_json::to_value(found).unwrap_or(Value::Null)
        }
        other => panic!("golden function {other} is not handled"),
    });
}
