//! Every function of `services/docs_text.py` against the vectors Python made (`contract/golden/docs_text.json`).

mod common;

use common::{os, s, u};
use kb_doctext::docs_text::{self, Reference};
use serde_json::{Value, json};

fn range_text(chars: &[char], r: (usize, usize)) -> String {
    chars[r.0..r.1].iter().collect()
}

#[test]
fn golden_docs_text() {
    common::run("docs_text.json", |name, a| match name {
        "slugify" => json!(docs_text::slugify(s(&a[0]))),
        "strip_inline" => json!(docs_text::strip_inline(s(&a[0]))),
        "strip_block_prefix" => json!(docs_text::strip_block_prefix(s(&a[0]), false)),
        "strip_block_prefix_headings" => json!(docs_text::strip_block_prefix(s(&a[0]), true)),
        "heading_match" => match docs_text::heading_match(s(&a[0])) {
            Some(m) => json!([m.hashes, m.text]),
            None => Value::Null,
        },
        "is_fence" => json!(docs_text::is_fence(s(&a[0]))),
        "ticket_keys" => {
            let chars: Vec<char> = s(&a[0]).chars().collect();
            json!(docs_text::ticket_matches(&chars).iter().map(|&(x, y)| json!([x, y])).collect::<Vec<_>>())
        }
        "first_ticket" => json!(docs_text::first_ticket(s(&a[0]))),
        "find_refs" => {
            let chars: Vec<char> = s(&a[0]).chars().collect();
            let found = docs_text::find_refs(&chars, 1);
            json!(
                found
                    .iter()
                    .map(|m| json!([
                        m.start,
                        m.end,
                        range_text(&chars, m.title),
                        m.anchor.map(|r| range_text(&chars, r)),
                        m.display.map(|r| range_text(&chars, r)),
                    ]))
                    .collect::<Vec<_>>()
            )
        }
        "link_labels" => json!(docs_text::link_labels(s(&a[0]))),
        "ref_labels" => json!(docs_text::ref_labels(s(&a[0]))),
        "remove_inline_code" => json!(docs_text::remove_inline_code(s(&a[0]))),
        "sentence_around" => {
            let limit = a.get(2).map_or(200, u);
            json!(docs_text::sentence_around(s(&a[0]), s(&a[1]), limit))
        }
        "ref_excerpt" => {
            let width = a.get(2).map_or(120, u);
            json!(docs_text::ref_excerpt(s(&a[0]), s(&a[1]), width))
        }
        "heading_anchors" => serde_json::to_value(docs_text::heading_anchors(s(&a[0]))).unwrap_or(Value::Null),
        "parse_references" => {
            let refs: Vec<Reference> = docs_text::parse_references(s(&a[0]));
            serde_json::to_value(refs).unwrap_or(Value::Null)
        }
        "page_ref_contexts" => serde_json::to_value(docs_text::page_ref_contexts(s(&a[0]))).unwrap_or(Value::Null),
        "rewrite_page_links" => {
            let (text, n) = docs_text::rewrite_page_links(s(&a[0]), s(&a[1]), s(&a[2]));
            json!([text, n])
        }
        "count_page_links" => json!(docs_text::count_page_links(s(&a[0]), s(&a[1]))),
        other => panic!("golden function {other} is not handled"),
    });
    let _ = os;
}
