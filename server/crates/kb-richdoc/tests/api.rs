//! The public functions of `kb-richdoc` outside the fixtures: the schema table, block ids, validation, the top-level
//! blocks and the annotated flavour's errors and inline syntax.

use std::collections::HashSet;
use std::path::Path;

use kb_richdoc::schema::{MARK_ORDER, schema};
use kb_richdoc::{
    FORMAT_VERSION, IdSource, RandomIds, RichDocError, SeqIds, annotated_to_doc, doc_to_annotated, doc_to_markdown,
    doc_to_text, ensure_block_ids, is_block_id, markdown_to_doc, top_level_blocks, validate,
};
use serde_json::{Value, json};

fn schema_file() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/richdoc/schema.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The embedded table is schema.json: every node, attribute, default and mark, in both directions.
#[test]
fn schema_table_agrees_with_schema_json() {
    let file = schema_file();
    let s = schema();
    assert_eq!(file["formatVersion"].as_u64(), Some(s.format_version));
    assert_eq!(u64::from(FORMAT_VERSION), s.format_version);
    let nodes = file["nodes"].as_object().unwrap();
    assert_eq!(nodes.len(), s.nodes.len());
    for (name, spec) in nodes {
        let table = s.nodes.get(name).unwrap_or_else(|| panic!("node {name} missing"));
        assert_eq!(spec.get("content").and_then(Value::as_str), table.content.as_deref(), "{name} content");
        let attrs = match &spec["attrs"] {
            Value::String(other) => nodes[other.trim_start_matches("same as ").trim()]["attrs"].clone(),
            a => a.clone(),
        };
        let attrs = attrs.as_object().cloned().unwrap_or_default();
        assert_eq!(attrs.len(), table.attrs.len(), "{name} attrs");
        for (k, a) in &attrs {
            let t = table.attrs.get(k).unwrap_or_else(|| panic!("{name}.{k} missing"));
            assert_eq!(a.get("default").cloned().unwrap_or(Value::Null), t.default, "{name}.{k} default");
        }
    }
    let marks = file["marks"].as_object().unwrap();
    let names: Vec<&str> = marks.keys().map(String::as_str).collect();
    assert_eq!(names, MARK_ORDER, "the canonical mark order is schema.json's");
    for (name, spec) in marks {
        let table = s.marks.get(name).unwrap();
        let attrs = spec.get("attrs").and_then(Value::as_object).cloned().unwrap_or_default();
        assert_eq!(attrs.len(), table.len(), "{name} attrs");
    }
    // the inline nodes (no block id) are the schema's inline group
    let inline: HashSet<&str> = nodes
        .iter()
        .filter(|(_, v)| {
            v.get("group").and_then(Value::as_str).is_some_and(|g| g.split_whitespace().any(|x| x == "inline"))
        })
        .map(|(k, _)| k.as_str())
        .collect();
    let crate_inline: HashSet<&str> = kb_richdoc::schema::INLINE_NODES.iter().copied().collect();
    assert_eq!(inline, crate_inline);
    for n in nodes.keys() {
        assert_eq!(kb_richdoc::carries_block_id(n), n != "doc" && !inline.contains(n.as_str()), "{n}");
    }
}

/// A page holding one node of every block type (and every inline node and mark) writes without panicking.
#[test]
fn every_node_type_writes() {
    let s = schema();
    for (name, spec) in &s.nodes {
        if name == "doc" || spec.groups.iter().any(|g| g == "inline") {
            continue;
        }
        let node = match name.as_str() {
            "listItem" | "taskItem" | "column" | "tableRow" | "tableCell" | "tableHeader" => continue,
            _ => json!({"type": name, "attrs": {"blockId": "b-000001"}}),
        };
        let doc = json!({"type": "doc", "content": [node]});
        let _ = doc_to_markdown(&doc);
        let _ = doc_to_text(&doc);
        let _ = doc_to_annotated(&doc);
    }
    let marks: Vec<Value> = MARK_ORDER.iter().map(|m| json!({"type": m})).collect();
    let doc = json!({"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "all", "marks": marks},
        {"type": "hardBreak"}, {"type": "docRef", "attrs": {"page": "P"}},
        {"type": "ticketRef", "attrs": {"key": "KAN-1"}}, {"type": "mathInline", "attrs": {"latex": "x"}}
    ]}]});
    assert!(!doc_to_markdown(&doc).is_empty());
}

#[test]
fn seq_ids_count_in_hex_and_random_ids_have_the_format() {
    let mut s = SeqIds(1);
    assert_eq!(s.next_id(), "b-000001");
    let mut s = SeqIds(9);
    assert_eq!(s.next_id(), "b-000009");
    assert_eq!(s.next_id(), "b-00000a");
    let mut r = RandomIds;
    let ids: HashSet<String> = (0..200).map(|_| r.next_id()).collect();
    assert!(ids.iter().all(|i| is_block_id(i)));
    assert!(ids.len() > 190, "random ids repeat too often");
    assert!(is_block_id("b-3f2a9c"));
    for bad in ["b-3F2A9C", "b-3f2a9", "b-3f2a9c0", "x-3f2a9c", "b_3f2a9c", ""] {
        assert!(!is_block_id(bad), "{bad}");
    }
}

#[test]
fn ensure_block_ids_fills_fixes_and_keeps() {
    let mut doc = json!({"type": "doc", "content": [
        {"type": "paragraph", "attrs": {"blockId": "b-00000a"}},
        {"type": "paragraph"},
        {"type": "paragraph", "attrs": {"blockId": "nope"}},
        {"type": "paragraph", "attrs": {"blockId": "b-00000a"}},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph",
            "content": [{"type": "text", "text": "x"}, {"type": "hardBreak"}]}]}]}
    ]});
    assert!(ensure_block_ids(&mut doc, &mut SeqIds(10)));
    let ids: Vec<&str> = top_level_blocks(&doc).iter().map(|b| b["attrs"]["blockId"].as_str().unwrap()).collect();
    // the first holder of b-00000a keeps it; SeqIds(10) would give b-00000a, which is taken, so b-00000b comes next
    assert_eq!(ids, ["b-00000a", "b-00000b", "b-00000c", "b-00000d", "b-00000e"]);
    let li = &doc["content"][4]["content"][0];
    assert!(is_block_id(li["attrs"]["blockId"].as_str().unwrap()));
    assert!(li["content"][0]["content"][0].get("attrs").is_none(), "text carries no id");
    assert!(li["content"][0]["content"][1].get("attrs").is_none(), "hard break carries no id");
    let before = doc.clone();
    assert!(!ensure_block_ids(&mut doc, &mut SeqIds(1)), "nothing to change");
    assert_eq!(doc, before);
}

#[test]
fn top_level_blocks_read_columns_in_order() {
    let doc = json!({"type": "doc", "content": [
        {"type": "paragraph", "attrs": {"blockId": "b-000001"}},
        {"type": "columns", "attrs": {"blockId": "b-000002"}, "content": [
            {"type": "column", "attrs": {"blockId": "b-000003"}, "content": [{"type": "paragraph", "attrs": {"blockId": "b-000004"}}]},
            {"type": "column", "attrs": {"blockId": "b-000005"}, "content": [{"type": "paragraph", "attrs": {"blockId": "b-000006"}}, {"type": "paragraph", "attrs": {"blockId": "b-000007"}}]}
        ]},
        {"type": "paragraph", "attrs": {"blockId": "b-000008"}}
    ]});
    let ids: Vec<&str> = top_level_blocks(&doc).iter().map(|b| b["attrs"]["blockId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["b-000001", "b-000002", "b-000004", "b-000006", "b-000007", "b-000008"]);
}

fn invalid(doc: Value) -> String {
    match validate(&doc) {
        Err(RichDocError::Invalid(m)) => m,
        other => panic!("expected Invalid, got {other:?} for {doc}"),
    }
}

#[test]
fn columns_hold_two_to_six_columns() {
    let cols = |n: usize| {
        let col = json!({"type": "column", "content": [{"type": "paragraph"}]});
        json!({"type": "doc", "content": [{"type": "columns", "content": vec![col; n]}]})
    };
    for n in 2..=6 {
        assert!(validate(&cols(n)).is_ok(), "{n} columns");
    }
    assert!(matches!(validate(&cols(7)), Err(RichDocError::Invalid(m)) if m.contains("column{2,6}")));
}

#[test]
fn validate_accepts_pages_and_names_the_first_problem() {
    let ok = markdown_to_doc("# T\n\n- a\n- [ ] b\n\n| x |\n|---|\n| y |\n\n> [!INFO]\n> z", &mut SeqIds(1));
    validate(&ok).unwrap();
    let p = |c: Value| json!({"type": "doc", "content": [c]});
    assert!(invalid(json!({"type": "paragraph"})).contains("not a doc"));
    assert!(invalid(json!({"type": "doc", "content": []})).contains("content"));
    assert!(invalid(p(json!({"type": "nope"}))).contains("nope"));
    assert!(
        invalid(json!({"type": "doc", "content": [{"type": "blockquote", "content": [{"type": "nope"}]}]}))
            .contains("nope")
    );
    assert!(invalid(p(json!({"type": "paragraph", "attrs": {"colour": "red"}}))).contains("unknown attribute colour"));
    assert!(invalid(p(json!({"type": "paragraph", "attrs": {"indent": 9}}))).contains("indent"));
    assert!(invalid(p(json!({"type": "paragraph", "attrs": {"textAlign": "middle"}}))).contains("textAlign"));
    assert!(invalid(p(json!({"type": "heading", "attrs": {"level": 7}}))).contains("level"));
    assert!(invalid(p(json!({"type": "listItem"}))).contains("not allowed"));
    assert!(invalid(p(json!({"type": "horizontalRule", "content": [{"type": "paragraph"}]}))).contains("leaf"));
    assert!(invalid(p(json!({"type": "paragraph", "content": [{"type": "text", "text": ""}]}))).contains("empty text"));
    assert!(
        invalid(p(
            json!({"type": "paragraph", "content": [{"type": "text", "text": "a", "marks": [{"type": "blink"}]}]})
        ))
        .contains("unknown mark")
    );
    assert!(
        invalid(p(json!({"type": "paragraph", "content": [{"type": "text", "text": "a",
        "marks": [{"type": "textStyle", "attrs": {"fontFamily": "comic"}}]}]})))
        .contains("fontFamily")
    );
    assert!(
        invalid(p(json!({"type": "columns", "content": [{"type": "column", "content": [{"type": "paragraph"}]}]})))
            .contains("column{2,6}")
    );
    assert!(invalid(p(json!({"type": "codeBlock", "content": [{"type": "hardBreak"}]}))).contains("hardBreak"));
    // too deep
    let mut deep = json!({"type": "paragraph"});
    for _ in 0..200 {
        deep = json!({"type": "blockquote", "content": [deep]});
    }
    assert!(invalid(p(deep)).contains("deeper"));
}

#[test]
fn markdown_reads_with_a_trailing_paragraph() {
    let doc = markdown_to_doc("# Title", &mut SeqIds(1));
    assert_eq!(
        doc,
        json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"blockId": "b-000001"}, "content": [{"type": "text", "text": "Title"}]},
            {"type": "paragraph", "attrs": {"blockId": "b-000002"}}
        ]})
    );
    assert_eq!(doc_to_markdown(&doc), "# Title\n");
    assert_eq!(doc_to_text(&doc), "Title");
    let empty = markdown_to_doc("", &mut SeqIds(1));
    assert_eq!(empty, json!({"type": "doc", "content": [{"type": "paragraph", "attrs": {"blockId": "b-000001"}}]}));
    assert_eq!(doc_to_markdown(&empty), "");
}

fn syntax(md: &str, existing: Option<&Value>) -> String {
    match annotated_to_doc(md, existing, &mut SeqIds(1)) {
        Err(RichDocError::Syntax(m)) => m,
        other => panic!("expected Syntax for {md:?}, got {other:?}"),
    }
}

#[test]
fn annotated_reads_markers_spans_and_page_reference_ids() {
    let md = "<!-- #b-00abcd align=center indent=2 -->\n[Big]{.underline color=teal size=24} and [up]{.sup}, ==plain==, [pink]{highlight=pink}.\n\n<!-- -->\n\n<!-- dropcap=3 -->\nNo id yet.\n\nNo marker either: [[Spec#Fields]]{page-id=pg_9 target=b-00ab12}\n\n<!-- #b-00abce codeBlock file=\"src/a b.rs\" numbers=true -->\n```rs\nfn main() {}\n```";
    let doc = annotated_to_doc(md, None, &mut SeqIds(1)).unwrap();
    validate(&doc).unwrap();
    let c = doc["content"].as_array().unwrap();
    assert_eq!(c[0]["attrs"], json!({"blockId": "b-00abcd", "indent": 2, "textAlign": "center"}));
    assert_eq!(
        c[0]["content"][0],
        json!({"type": "text", "marks": [{"type": "underline"}, {"type": "textStyle", "attrs": {"color": "teal", "fontSize": 24}}], "text": "Big"})
    );
    assert_eq!(c[0]["content"][2]["marks"], json!([{"type": "superscript"}]));
    assert_eq!(c[0]["content"][4]["marks"], json!([{"type": "highlight"}]));
    assert_eq!(c[0]["content"][6]["marks"], json!([{"type": "highlight", "attrs": {"color": "pink"}}]));
    // a plain comment is a block of its own (as in plain Markdown): an empty paragraph
    assert_eq!(c[1]["type"], "paragraph");
    assert_eq!(c[2]["attrs"]["dropCap"], 3);
    assert!(is_block_id(c[2]["attrs"]["blockId"].as_str().unwrap()), "a marker without id gets one");
    assert_eq!(
        c[3]["content"][1]["attrs"],
        json!({"page": "Spec", "pageId": "pg_9", "section": "Fields", "targetBlockId": "b-00ab12"})
    );
    assert_eq!(
        c[4]["attrs"],
        json!({"blockId": "b-00abce", "filename": "src/a b.rs", "language": "rs", "lineNumbers": true})
    );
    // and writes them back the same way
    let again = annotated_to_doc(&doc_to_annotated(&doc), Some(&doc), &mut SeqIds(0xe00000)).unwrap();
    assert_eq!(again, doc);
}

#[test]
fn annotated_errors() {
    assert!(syntax("<!-- #b-12 -->\nx", None).contains("not a block id"));
    assert!(syntax("<!-- #b-000001 colour=red -->\nx", None).contains("no attribute colour"));
    assert!(syntax("<!-- #b-000001 indent=lots -->\nx", None).contains("indent=lots"));
    assert!(syntax("<!-- #b-000001 indent=9 -->\nx", None).contains("indent=9"));
    assert!(syntax("<!-- #b-000001 gizmo -->\nx", None).contains("unknown block type gizmo"));
    assert!(syntax("<!-- #b-000001 title=\"open -->\nx", None).contains("not closed"));
    assert!(syntax("<!-- column -->\nx", None).contains("outside"));
    assert!(syntax("<!-- /columns -->", None).contains("without"));
    assert!(syntax("[x]{.blink}", None).contains("blink"));
    assert!(syntax("[x]{font=comic}", None).contains("comic"));
    assert!(syntax("[x]{size=big}", None).contains("size"));
    // a placeholder needs its block in the page
    match annotated_to_doc("<!-- #b-000009 video -->\n[embed: video · Demo]", None, &mut SeqIds(1)) {
        Err(RichDocError::NoBlock(id)) => assert_eq!(id, "b-000009"),
        other => panic!("{other:?}"),
    }
    // a video has no Markdown form
    match annotated_to_doc("<!-- #b-000009 video -->\nSome text", None, &mut SeqIds(1)) {
        Err(RichDocError::Placeholder(_)) => {}
        other => panic!("{other:?}"),
    }
    // markers inside fenced code are code; prose comments are not markers
    let doc = annotated_to_doc("```\n<!-- #b-zz -->\n```\n\n<!-- just a note -->", None, &mut SeqIds(1)).unwrap();
    assert_eq!(doc["content"][0]["content"][0]["text"], "<!-- #b-zz -->");
}

#[test]
fn annotated_keeps_placeholders_and_unchanged_blocks() {
    let page = json!({"type": "doc", "content": [
        {"type": "video", "attrs": {"blockId": "b-000001", "src": "/v.mp4", "title": "Demo", "loop": true}},
        {"type": "paragraph", "attrs": {"blockId": "b-000002"}, "content": [
            {"type": "text", "text": "word", "marks": [{"type": "bold"}]},
            {"type": "text", "text": " ", "marks": [{"type": "bold"}, {"type": "italic"}]},
            {"type": "text", "text": "next"}]}
    ]});
    let md = doc_to_annotated(&page);
    assert!(md.starts_with("<!-- #b-000001 video -->\n[embed: video · Demo]"), "{md}");
    assert_eq!(annotated_to_doc(&md, Some(&page), &mut SeqIds(9)).unwrap(), page);
    // the marked space cannot be written, but the unchanged block keeps it
    assert!(md.contains("**word** next"), "{md}");
    // an edited block takes the edit
    let edited = md.replace("**word** next", "**word** later");
    let doc = annotated_to_doc(&edited, Some(&page), &mut SeqIds(9)).unwrap();
    assert_eq!(doc["content"][1]["content"][1]["text"], " later");
    assert_eq!(doc["content"][0], page["content"][0]);
}
