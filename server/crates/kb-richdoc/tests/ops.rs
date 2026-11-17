//! Block edits (`ops::apply`) and whole-page updates (`ops::replace_page`).

use kb_richdoc::ops::{BlockOp, apply, replace_page};
use kb_richdoc::{RichDocError, SeqIds, doc_to_annotated, top_level_blocks, validate};
use serde_json::{Map, Value, json};

fn page() -> Value {
    json!({"type": "doc", "content": [
        {"type": "heading", "attrs": {"blockId": "b-000001", "level": 2}, "content": [{"type": "text", "text": "Plan"}]},
        {"type": "paragraph", "attrs": {"blockId": "b-000002", "textAlign": "center"}, "content": [{"type": "text", "text": "First."}]},
        {"type": "video", "attrs": {"blockId": "b-000003", "src": "/v.mp4", "title": "Demo"}},
        {"type": "columns", "attrs": {"blockId": "b-000004"}, "content": [
            {"type": "column", "attrs": {"blockId": "b-000005"}, "content": [
                {"type": "paragraph", "attrs": {"blockId": "b-000006"}, "content": [{"type": "text", "text": "Left"}]}]},
            {"type": "column", "attrs": {"blockId": "b-000007"}, "content": [
                {"type": "paragraph", "attrs": {"blockId": "b-000008"}, "content": [{"type": "text", "text": "Right"}]},
                {"type": "video", "attrs": {"blockId": "b-000009", "src": "/w.mp4"}}]}
        ]},
        {"type": "bulletList", "attrs": {"blockId": "b-00000a"}, "content": [
            {"type": "listItem", "attrs": {"blockId": "b-00000b"}, "content": [
                {"type": "paragraph", "attrs": {"blockId": "b-00000c"}, "content": [{"type": "text", "text": "item"}]}]}]}
    ]})
}

fn ids(doc: &Value) -> Vec<String> {
    top_level_blocks(doc).iter().map(|b| b["attrs"]["blockId"].as_str().unwrap_or("").to_string()).collect()
}

fn run(edits: Vec<BlockOp>) -> Result<Value, RichDocError> {
    let doc = apply(&page(), &edits, &mut SeqIds(0xa00000))?;
    validate(&doc).unwrap();
    Ok(doc)
}

#[test]
fn replace_keeps_the_id_and_gives_new_blocks_fresh_ones() {
    let doc = run(vec![BlockOp::Replace {
        block_id: "b-000002".into(),
        markdown: "Second *version*.\n\n<!-- #b-000001 -->\nAnother block that claims a taken id.".into(),
    }])
    .unwrap();
    assert_eq!(
        ids(&doc),
        ["b-000001", "b-000002", "b-a00000", "b-000003", "b-000004", "b-000006", "b-000008", "b-000009", "b-00000a"]
    );
    let first = &doc["content"][1];
    assert_eq!(first["content"][1], json!({"type": "text", "marks": [{"type": "italic"}], "text": "version"}));
    assert!(first["attrs"].get("textAlign").is_none(), "a block without marker attributes takes none");
    // the heading kept its id: the second block's marker did not take it
    assert_eq!(doc["content"][0]["content"][0]["text"], "Plan");
}

#[test]
fn replace_with_the_written_block_changes_nothing() {
    let annotated = doc_to_annotated(&page());
    let chunk = annotated.split("\n\n").nth(1).unwrap().to_string();
    assert!(chunk.starts_with("<!-- #b-000002 align=center -->"), "{chunk}");
    let doc = run(vec![BlockOp::Replace { block_id: "b-000002".into(), markdown: chunk }]).unwrap();
    assert_eq!(doc, page());
}

#[test]
fn replace_refuses_placeholders_unknown_ids_and_empty_fragments() {
    match run(vec![BlockOp::Replace { block_id: "b-000003".into(), markdown: "text".into() }]) {
        Err(RichDocError::Placeholder(m)) => assert!(m.contains("only be deleted"), "{m}"),
        other => panic!("{other:?}"),
    }
    match run(vec![BlockOp::Replace { block_id: "b-0000ff".into(), markdown: "text".into() }]) {
        Err(RichDocError::NoBlock(id)) => assert_eq!(id, "b-0000ff"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        run(vec![BlockOp::Replace { block_id: "b-000002".into(), markdown: "  \n".into() }]),
        Err(RichDocError::Syntax(_))
    ));
    assert!(matches!(
        run(vec![BlockOp::Replace { block_id: "b-000002".into(), markdown: "<!-- #b-1 -->\nx".into() }]),
        Err(RichDocError::Syntax(_))
    ));
    // nested blocks are not edit targets
    assert!(matches!(
        run(vec![BlockOp::Replace { block_id: "b-00000c".into(), markdown: "x".into() }]),
        Err(RichDocError::NoBlock(_))
    ));
}

#[test]
fn insert_after_a_block_at_the_start_and_in_a_column() {
    let doc = run(vec![
        BlockOp::InsertAfter { block_id: None, markdown: "Top.".into() },
        BlockOp::InsertAfter {
            block_id: Some("b-000006".into()),
            markdown: "<!-- #b-000002 -->\nIn the left column.".into(),
        },
        BlockOp::InsertAfter { block_id: Some("b-00000a".into()), markdown: "- a\n- b\n\nEnd.".into() },
    ])
    .unwrap();
    let all = ids(&doc);
    assert_eq!(all[0], "b-a00000");
    assert_eq!(doc["content"][0]["content"][0]["text"], "Top.");
    let left = &doc["content"][4]["content"][0]["content"];
    assert_eq!(left[1]["content"][0]["text"], "In the left column.");
    assert_ne!(left[1]["attrs"]["blockId"], "b-000002", "an inserted block never takes an id");
    let last = doc["content"].as_array().unwrap();
    assert_eq!(last[last.len() - 1]["content"][0]["text"], "End.");
    assert_eq!(last[last.len() - 2]["type"], "bulletList");
    // every id is unique and the old ones are where they were
    let mut seen = std::collections::HashSet::new();
    fn walk(n: &Value, seen: &mut std::collections::HashSet<String>) {
        if let Some(id) = n["attrs"]["blockId"].as_str() {
            assert!(seen.insert(id.to_string()), "duplicate {id}");
        }
        for c in n["content"].as_array().into_iter().flatten() {
            walk(c, seen);
        }
    }
    walk(&doc, &mut seen);
    for old in ["b-000001", "b-000002", "b-000003", "b-000006", "b-00000c"] {
        assert!(seen.contains(old));
    }
    assert!(matches!(
        run(vec![BlockOp::InsertAfter { block_id: Some("b-0000ff".into()), markdown: "x".into() }]),
        Err(RichDocError::NoBlock(_))
    ));
    assert!(matches!(
        run(vec![BlockOp::InsertAfter { block_id: None, markdown: "".into() }]),
        Err(RichDocError::Syntax(_))
    ));
}

#[test]
fn delete_removes_blocks_and_keeps_containers_valid() {
    let doc =
        run(vec![BlockOp::Delete { block_id: "b-000003".into() }, BlockOp::Delete { block_id: "b-000006".into() }])
            .unwrap();
    assert!(!ids(&doc).contains(&"b-000003".to_string()), "a placeholder goes by delete");
    // the emptied column holds an empty paragraph
    let left = &doc["content"][2]["content"][0];
    assert_eq!(left["attrs"]["blockId"], "b-000005");
    assert_eq!(left["content"].as_array().unwrap().len(), 1);
    assert_eq!(left["content"][0]["type"], "paragraph");
    // deleting a columns block deletes what it holds
    let doc = run(vec![BlockOp::Delete { block_id: "b-000004".into() }]).unwrap();
    assert_eq!(ids(&doc), ["b-000001", "b-000002", "b-000003", "b-00000a"]);
    // deleting everything leaves an empty page
    let all: Vec<BlockOp> = ["b-000001", "b-000002", "b-000003", "b-000004", "b-00000a"]
        .iter()
        .map(|i| BlockOp::Delete { block_id: (*i).into() })
        .collect();
    let doc = run(all).unwrap();
    assert_eq!(doc["content"].as_array().unwrap().len(), 1);
    assert_eq!(doc["content"][0]["type"], "paragraph");
    assert!(matches!(
        run(vec![BlockOp::Delete { block_id: "b-000003".into() }, BlockOp::Delete { block_id: "b-000003".into() }]),
        Err(RichDocError::NoBlock(_))
    ));
}

fn attrs(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

#[test]
fn set_attrs_sets_clears_and_refuses() {
    let doc = run(vec![
        BlockOp::SetAttrs {
            block_id: "b-000002".into(),
            attrs: attrs(json!({"textAlign": null, "dropcap": 3, "lineHeight": 1.5})),
        },
        BlockOp::SetAttrs { block_id: "b-000003".into(), attrs: attrs(json!({"loop": true, "width": 60})) },
    ])
    .unwrap();
    assert_eq!(doc["content"][1]["attrs"], json!({"blockId": "b-000002", "dropCap": 3, "lineHeight": 1.5}));
    assert_eq!(doc["content"][2]["attrs"]["loop"], true);
    assert_eq!(doc["content"][2]["attrs"]["widthPct"], 60);
    // set back to the default: left out
    let doc2 = apply(
        &doc,
        &[BlockOp::SetAttrs { block_id: "b-000002".into(), attrs: attrs(json!({"dropCap": 0})) }],
        &mut SeqIds(1),
    )
    .unwrap();
    assert!(doc2["content"][1]["attrs"].get("dropCap").is_none());
    for (bad, what) in [
        (json!({"level": 2}), "no attribute level"),
        (json!({"colour": "red"}), "no attribute colour"),
        (json!({"blockId": "b-123456"}), "no attribute blockId"),
        (json!({"indent": 12}), "indent"),
        (json!({"textAlign": "middle"}), "textAlign"),
    ] {
        match run(vec![BlockOp::SetAttrs { block_id: "b-000002".into(), attrs: attrs(bad) }]) {
            Err(RichDocError::Invalid(m)) => assert!(m.contains(what), "{m}"),
            other => panic!("{other:?}"),
        }
    }
    assert!(matches!(
        run(vec![BlockOp::SetAttrs { block_id: "b-0000ff".into(), attrs: Map::new() }]),
        Err(RichDocError::NoBlock(_))
    ));
}

#[test]
fn edits_apply_in_order_and_fail_whole() {
    let before = page();
    let r = apply(
        &before,
        &[
            BlockOp::Delete { block_id: "b-000002".into() },
            BlockOp::Replace { block_id: "b-000002".into(), markdown: "x".into() },
        ],
        &mut SeqIds(1),
    );
    assert!(matches!(r, Err(RichDocError::NoBlock(_))));
    assert_eq!(before, page(), "the page itself is not touched");
}

#[test]
fn replace_page_keeps_known_ids_and_left_out_placeholders() {
    let md = "<!-- #b-000001 -->\n## Plan\n\n<!-- #b-000002 align=center -->\nFirst, edited.\n\n<!-- #b-00ff00 -->\nA marker the page does not know.\n\n<!-- #b-000004 columns -->\n<!-- #b-000005 column -->\n<!-- #b-000006 -->\nLeft\n<!-- #b-000007 column -->\n<!-- /columns -->\n\nNew paragraph.";
    let doc = replace_page(&page(), md, &mut SeqIds(0xb00000)).unwrap();
    validate(&doc).unwrap();
    let all = ids(&doc);
    // the two videos come back where they were: after "First" and first in the right column (which is not given
    // an empty paragraph, as an empty column would be)
    assert_eq!(all, ["b-000001", "b-000002", "b-000003", "b-b00000", "b-000004", "b-000006", "b-000009", "b-b00001"]);
    assert_eq!(doc["content"][4]["content"][1]["content"].as_array().map(Vec::len), Some(1));
    assert_eq!(doc["content"][1]["content"][0]["text"], "First, edited.");
    assert_eq!(doc["content"][2], page()["content"][2]);
    let right = &doc["content"][4]["content"][1];
    assert_eq!(right["attrs"]["blockId"], "b-000007");
    assert_eq!(right["content"][0]["attrs"]["blockId"], "b-000009");
    // the list was left out and is gone (it is not a placeholder)
    assert!(!all.contains(&"b-00000a".to_string()));
    // the written page reads back as itself
    assert_eq!(replace_page(&page(), &doc_to_annotated(&page()), &mut SeqIds(1)).unwrap(), page());
}

#[test]
fn replace_page_reports_broken_markdown() {
    assert!(matches!(replace_page(&page(), "<!-- #b-00 -->\nx", &mut SeqIds(1)), Err(RichDocError::Syntax(_))));
    assert!(matches!(
        replace_page(&page(), "<!-- #b-00abcd video -->\n[embed: video · nope]", &mut SeqIds(1)),
        Err(RichDocError::NoBlock(_))
    ));
}
