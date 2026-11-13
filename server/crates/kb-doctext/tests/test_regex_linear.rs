//! `tests/test_regex_linear.py`: the docs patterns stay linear on hostile input. The two checks that call
//! `docs_search._trim_nonword` and `tickets.mention_ids` belong to the modules that own those functions.

use std::time::Instant;

use kb_doctext::docs_text::{
    heading_anchors, heading_match, page_ref_contexts, parse_references, strip_block_prefix, strip_inline,
};

fn hostile() -> Vec<String> {
    vec![
        "[[".repeat(25_000),
        "[[\"#".repeat(12_500),
        "[x](".repeat(12_500),
        "@[".repeat(25_000),
        "@[a](member:".repeat(5_000),
        format!("{}x", " ".repeat(50_000)),
        format!("{}a", "/".repeat(50_000)),
        format!("## {} x", "#".repeat(50_000)),
        format!("- {}", " ".repeat(50_000)),
    ]
}

#[test]
fn test_hostile_input_is_fast() {
    for text in hostile() {
        let start = Instant::now();
        strip_inline(&text);
        parse_references(&text);
        page_ref_contexts(&text, None);
        heading_anchors(&text);
        strip_block_prefix(&text, false);
        strip_block_prefix(&text, true);
        heading_match(&text);
        assert!(start.elapsed().as_secs_f64() < 2.0, "{:?} took {:?}", &text[..text.len().min(20)], start.elapsed());
    }
}

#[test]
fn test_reference_forms_still_parse() {
    use kb_doctext::docs_text::Reference;
    let refs = parse_references("See [[A]], [[A#B]] and [[A#B|label]] and KAN-12.");
    let pages: Vec<(String, Option<String>, Option<String>)> = refs
        .iter()
        .filter_map(|r| match r {
            Reference::Page(p) => Some((p.title.clone(), p.anchor.clone(), p.display.clone())),
            Reference::Ticket(_) => None,
        })
        .collect();
    let some = |s: &str| Some(s.to_string());
    assert_eq!(
        pages,
        vec![
            ("A".to_string(), None, None),
            ("A".to_string(), some("B"), None),
            ("A".to_string(), some("B"), some("label"))
        ]
    );
    let keys: Vec<&str> = refs
        .iter()
        .filter_map(|r| match r {
            Reference::Ticket(t) => Some(t.key.as_str()),
            Reference::Page(_) => None,
        })
        .collect();
    assert_eq!(keys, ["KAN-12"]);
    assert_eq!(strip_inline("a [[P#S|shown]] and [t](http://x) b"), "a shown and t b");
}

#[test]
fn test_heading_forms() {
    let h = heading_match;
    let m = h("## Title").expect("a heading");
    assert!(m.text == "Title" && m.hashes == "##");
    assert_eq!(h("## Title ##").expect("a heading").text, "Title");
    assert_eq!(h("## C#").expect("a heading").text, "C#");
    assert!(h("#Title").is_none() && h("####### seven").is_none() && h("##   ").is_none());
    let slugs: Vec<String> = heading_anchors("# One\n## One\n```\n# no\n```").into_iter().map(|a| a.slug).collect();
    assert_eq!(slugs, ["one", "one-2"]);
}

#[test]
fn test_block_prefix_and_trim_and_mentions() {
    assert_eq!(strip_block_prefix("- [x] see [[A]]", false), "see [[A]]");
    assert_eq!(strip_block_prefix("> 1. item", false), "item");
    assert_eq!(strip_block_prefix("## Head", true), "Head");
}
