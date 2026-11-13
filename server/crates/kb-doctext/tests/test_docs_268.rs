//! The pure-function tests of `tests/test_docs_268.py` (the edits, the Docs guide, quotes of highlighted text). The
//! tests that go through MCP and HTTP belong to the Docs area (`kb-docs`).

use kb_doctext::docs_anchors::{blocks_of, find_anchor};
use kb_doctext::docs_edit::{self, Edit, EditError};
use kb_doctext::docs_guide;
use kb_doctext::docs_text::heading_anchors;

const PAGE: &str = "## Overview

The API is REST.

## Endpoints

| Method | Path |
|---|---|
| GET | /tickets |

### Errors

401 when the token is missing.

## Limits

Rate limits are not enforced yet.
";

fn message<T: std::fmt::Debug>(r: Result<T, EditError>) -> String {
    r.expect_err("an EditError was expected").0
}

#[test]
fn test_sections_follow_headings_and_skip_code() {
    let md = "## A\nx\n```\n## not a heading\n```\n### A1\ny\n## A\nz\n";
    let got: Vec<(usize, String, String)> =
        docs_edit::sections(md).into_iter().map(|s| (s.level, s.text, s.slug)).collect();
    let want = [(2, "A", "a"), (3, "A1", "a1"), (2, "A", "a-2")];
    assert_eq!(got, want.iter().map(|(l, t, s)| (*l, t.to_string(), s.to_string())).collect::<Vec<_>>());
    assert_eq!(docs_edit::section_text(md, "A1").unwrap(), "### A1\ny");
    // pytest.raises(match="2 headings.*a, a-2")
    let m = message(docs_edit::find_section(md, "A"));
    assert!(m.contains("2 headings") && m.contains("a, a-2"), "{m}");
    assert_eq!(docs_edit::section_text(md, "a-2").unwrap(), "## A\nz");
}

#[test]
fn test_edit_section_modes() {
    let out = docs_edit::edit_section(PAGE, "Limits", "Rate limits are 100 per minute.", "replace").unwrap();
    assert!(out.contains("## Limits\n\nRate limits are 100 per minute.\n"));
    assert!(!out.contains("not enforced") && out.contains("## Overview\n\nThe API is REST."));
    // replacing a section takes its sub-sections; a heading of its level renames it
    let out = docs_edit::edit_section(PAGE, "endpoints", "## Routes\n\nSee the spec.", "replace").unwrap();
    assert!(!out.contains("## Endpoints") && !out.contains("### Errors"));
    assert!(out.contains("## Routes\n\nSee the spec.\n\n## Limits"));
    let out = docs_edit::edit_section(PAGE, "Endpoints", "| POST | /tickets |", "append").unwrap();
    assert!(out.contains("401 when the token is missing.\n\n| POST | /tickets |\n\n## Limits"));
    let out = docs_edit::edit_section(PAGE, "Overview", "## Auth\n\nTokens.", "after").unwrap();
    assert!(out.contains("The API is REST.\n\n## Auth\n\nTokens.\n\n## Endpoints"));
    let out = docs_edit::edit_section(PAGE, "Limits", "> [!WARNING]\n> Soon.", "prepend").unwrap();
    assert!(out.contains("## Limits\n\n> [!WARNING]\n> Soon.\n\nRate limits"));
    // pytest.raises(match="not on the page.*'Overview'")
    let m = message(docs_edit::edit_section(PAGE, "Billing", "x", "replace"));
    assert!(m.contains("not on the page") && m.contains("'Overview'"), "{m}");
}

#[test]
fn test_edit_passage_needs_one_exact_match() {
    let out = docs_edit::edit_passage(PAGE, "not enforced yet", "enforced since v2", "replace").unwrap();
    assert!(out.contains("Rate limits are enforced since v2."));
    assert!(message(docs_edit::edit_passage(PAGE, "not  enforced", "x", "replace")).contains("not on the page"));
    let twice = format!("{PAGE}\nThe API is REST.\n");
    assert!(message(docs_edit::edit_passage(&twice, "The API is REST.", "x", "replace")).contains("2 times"));
    assert_eq!(docs_edit::append_page("## A\nx\n", "## B\ny"), "## A\nx\n\n## B\ny\n");
}

#[test]
fn test_a_section_edit_from_an_old_version_goes_on_only_if_that_section_is_unchanged() {
    let now = PAGE.replace("The API is REST.", "The API is REST and MCP.");
    let edit = |section: &str, markdown: &str| Edit {
        section: Some(section.to_string()),
        markdown: Some(markdown.to_string()),
        ..Edit::default()
    };
    // someone changed Overview: an edit of Limits made from the old text still applies
    let out = docs_edit::apply(&now, &edit("Limits", "100/min."), Some(PAGE)).unwrap();
    assert!(out.contains("REST and MCP") && out.contains("100/min."));
    // but an edit of Overview made from the old text is refused, with the text as it is now
    let m = message(docs_edit::apply(&now, &edit("Overview", "x"), Some(PAGE)));
    let at = m.find("conflict").expect("conflict");
    assert!(m[at..].contains("REST and MCP"), "{m}");
}

#[test]
fn test_the_docs_guide_is_one_text_in_both_places() {
    // the part of the test that needs no skills: the guide names the Markdown the editor keeps
    assert_eq!(docs_guide::guide()["guide"], serde_json::Value::String(docs_guide::GUIDE.to_string()));
    for form in ["==", "> [!WARNING]", "- [ ]", "[[Page#Section]]", "action='edit'", "action='upload'"] {
        assert!(docs_guide::GUIDE.contains(form), "{form}");
    }
}

#[test]
fn test_the_docs_skill_says_a_written_result_is_a_page_not_a_repository_file() {
    // tests/test_ai_launch_v2.py
    assert!(docs_guide::GUIDE.contains("## 1. A page, a ticket comment, or a file?"));
    assert!(docs_guide::GUIDE.contains("not a Markdown file in the repository"));
    assert!(docs_guide::SKILL_HEADER.contains("in a file of the repository"));
}

#[test]
fn test_a_quote_of_highlighted_text_is_found_and_headings_drop_the_marks() {
    let md = "## The ==key== rule\n\nA person signs in. ==Five failed attempts lock the account.==\n";
    let hit = find_anchor(&blocks_of(md), "Five failed attempts lock the account.", "", "", None);
    assert!(hit.is_some_and(|h| h.exact));
    assert_eq!(heading_anchors(md)[0].text, "The key rule");
}
