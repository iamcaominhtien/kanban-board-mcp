//! Docs for AI (issue #268): the part of `tests/test_docs_268.py` that goes through `board_skills`
//! (`test_the_docs_guide_is_one_text_in_both_places`). The rest of that file tests the Docs tools and routes (`kb-mcp`),
//! and its `ops=board_skills` line at 387 is the launcher's use of the switch (`kb-ai-run`).

mod common;

use kb_ai_know::board_skills;
use kb_doctext::docs_guide;

#[tokio::test]
async fn test_the_docs_guide_is_one_text_in_both_places() {
    let out = docs_guide::guide();
    assert_eq!(out["guide"], docs_guide::GUIDE);
    let skill = board_skills::skill_text("docs-pages").expect("a skill");
    assert_eq!(skill, format!("{}{}", docs_guide::SKILL_HEADER, docs_guide::GUIDE));
    assert!(board_skills::catalog().iter().any(|s| s["name"] == "docs-pages"));
    // the guide names the Markdown the editor keeps
    for form in ["==", "> [!WARNING]", "- [ ]", "[[Page#Section]]", "action='edit'", "action='upload'"] {
        assert!(docs_guide::GUIDE.contains(form), "{form}");
    }
}
