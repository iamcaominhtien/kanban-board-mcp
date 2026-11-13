//! The pure-helper tests of `tests/test_docs.py` that use `docs_text` (`diff_markdown` and the HTTP tests belong to the
//! Docs area).

use kb_doctext::docs_text::{Reference, heading_anchors, parse_references, slugify};

#[test]
fn test_slugify_and_duplicate_anchors() {
    assert_eq!(slugify("Example request!"), "example-request");
    let md = "## Overview\n\n```\n## not a heading\n```\n\n## Overview\n\n### `Code` bit";
    let slugs: Vec<String> = heading_anchors(md).into_iter().map(|h| h.slug).collect();
    assert_eq!(slugs, ["overview", "overview-2", "code-bit"]);
}

#[test]
fn test_parse_references_skips_code_and_tracks_sections() {
    let md = "## Intro\nSee [[Data model#Fields|the fields]] and KAN-12.\n\
              `[[Ignored]] KAN-99`\n```\n[[Fenced]] KAN-98\n```\n## Next\n[[Auth]]";
    let refs = parse_references(md);
    let got: Vec<(&str, String, Option<String>)> = refs
        .iter()
        .map(|r| match r {
            Reference::Page(p) => ("page", p.title.clone(), p.section.clone()),
            Reference::Ticket(t) => ("ticket", t.key.clone(), t.section.clone()),
        })
        .collect();
    let some = |s: &str| Some(s.to_string());
    assert_eq!(
        got,
        vec![
            ("page", "Data model".to_string(), some("intro")),
            ("ticket", "KAN-12".to_string(), some("intro")),
            ("page", "Auth".to_string(), some("next")),
        ]
    );
    let Reference::Page(first) = &refs[0] else { panic!("a page reference first") };
    assert_eq!(first.anchor.as_deref(), Some("Fields"));
    assert_eq!(first.display.as_deref(), Some("the fields"));
}
