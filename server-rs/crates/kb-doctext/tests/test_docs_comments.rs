//! The pure anchor tests of `tests/test_docs_comments.py` (`docs_anchors`). The tests that go through HTTP belong to the
//! Docs area (`kb-docs`).

use kb_doctext::docs_anchors::{blocks_of, find_anchor};

const DOC: &str = "# API\n\n\
    Every route requires a bearer token; rotation rules live in [[Auth]].\n\n\
    ## Limits\n\n\
    Rate limits are not enforced yet. Tracked in KAN-12.\n\n\
    | Method | Path |\n|---|---|\n| GET | /tickets |\n";

#[test]
fn test_blocks_strip_markdown_and_split_blocks() {
    let blocks = blocks_of(DOC);
    let texts: Vec<&str> = blocks.iter().map(|b| b.text.as_str()).collect();
    assert!(texts.contains(&"Every route requires a bearer token; rotation rules live in Auth."));
    assert!(texts.contains(&"GET") && texts.contains(&"/tickets")); // table cells are blocks
    let limits = blocks.iter().find(|b| b.text.starts_with("Rate limits")).expect("a Limits block");
    assert_eq!(limits.section.as_deref(), Some("limits"));
}

#[test]
fn test_exact_match_prefers_the_best_context() {
    let blocks = blocks_of("# T\n\nfoo bar baz.\n\nqux bar quux.\n");
    let hit = find_anchor(&blocks, "bar", "qux ", " quux", None).expect("a match");
    assert!(hit.exact && hit.prefix.contains("qux"));
}

#[test]
fn test_edited_text_stays_attached_and_changed_text_is_refreshed() {
    let blocks = blocks_of("Every route requires a valid bearer token always.");
    let hit = find_anchor(&blocks, "bearer token", "requires a ", "", None).expect("a match");
    assert!(hit.exact);
    let blocks = blocks_of("Read the bearer token rotation policy first.");
    let hit = find_anchor(&blocks, "bearer token rotation rules", "", "", None).expect("a match");
    assert!(!hit.exact && hit.quote.starts_with("bearer token rotation"));
}

#[test]
fn test_missing_text_does_not_match() {
    let blocks = blocks_of("Nothing alike lives here at all.");
    assert!(find_anchor(&blocks, "bearer token", "", "", None).is_none());
}

#[test]
fn test_find_anchor_across_blocks_takes_the_section_it_starts_in() {
    let blocks = blocks_of("## One\n\nalpha beta\n\n## Two\n\ngamma delta\n");
    let hit = find_anchor(&blocks, "beta Two gamma", "", "", None).expect("a match");
    assert!(hit.exact);
    assert_eq!(hit.section.as_deref(), Some("one"));
    assert!(hit.prefix.ends_with("alpha ") && hit.suffix == " delta");
}
