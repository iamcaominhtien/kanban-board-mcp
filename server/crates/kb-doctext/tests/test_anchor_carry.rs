//! Carrying comment anchors across a publish (`carry_anchor`) and the weighed fallback search (`relocate`).

use kb_doctext::docs_anchors::{Block, Carried, Change, blocks_of, carry_anchor, relocate};

/// Offset in the page text of `quote` inside the `nth` block that holds it.
fn pos_in(blocks: &[Block], nth: usize, quote: &str) -> usize {
    let b = blocks.iter().filter(|b| b.text.contains(quote)).nth(nth).expect("the block");
    let byte = b.text.find(quote).expect("the quote");
    b.start + b.text[..byte].chars().count()
}

/// The block the new position falls in.
fn block_index(blocks: &[Block], pos: usize) -> usize {
    blocks.iter().rposition(|b| b.start <= pos).expect("a block")
}

fn attached(c: Option<Carried>) -> (Change, kb_doctext::docs_anchors::Match) {
    match c {
        Some(Carried::Attached(change, m)) => (change, m),
        other => panic!("expected an attached anchor, got {other:?}"),
    }
}

#[test]
fn test_two_identical_paragraphs_keep_the_one_commented_on() {
    let old = blocks_of("# T\n\nSee the note.\n\nRepeat me.\n\nMiddle.\n\nRepeat me.\n");
    let new = blocks_of("# T\n\nSee the note, now longer.\n\nRepeat me.\n\nMiddle changed.\n\nRepeat me.\n");
    let pos = pos_in(&old, 1, "Repeat me.");
    let (change, m) = attached(carry_anchor(&old, &new, pos, "Repeat me."));
    assert_eq!(change, Change::Kept);
    assert_eq!(block_index(&new, m.pos), 4, "the second copy, not the first");
}

#[test]
fn test_light_edit_in_place_beats_an_exact_copy_elsewhere() {
    let old = blocks_of("Intro.\n\nThe retry budget is five per hour.\n");
    let new = blocks_of("Intro: the retry budget is five.\n\nThe retry budget is six per hour.\n");
    let pos = pos_in(&old, 0, "retry budget is five");
    let (change, m) = attached(carry_anchor(&old, &new, pos, "retry budget is five"));
    assert_eq!(change, Change::Edited);
    assert_eq!(m.quote, "retry budget is six");
    assert_eq!(block_index(&new, m.pos), 1, "stays in its own paragraph");
}

#[test]
fn test_rewritten_text_moves_to_the_text_that_replaced_it() {
    let old = blocks_of("## Scan\n\nBefore.\n\nInferred from the menu, not checked.\n\nAfter.\n");
    let new = blocks_of("## Scan\n\nBefore.\n\nChecked on all three lines: hidden in single mode.\n\nAfter.\n");
    let pos = pos_in(&old, 0, "Inferred from the menu");
    let (change, m) = attached(carry_anchor(&old, &new, pos, "Inferred from the menu, not checked."));
    assert_eq!(change, Change::Rewritten);
    assert_eq!(m.quote, "Checked on all three lines: hidden in single mode.");
    assert_eq!(m.section.as_deref(), Some("scan"));
}

#[test]
fn test_split_paragraph_follows_its_part() {
    let old = blocks_of("Start.\n\nFirst half here. Second half with the quote inside.\n\nEnd.\n");
    let new = blocks_of("Start.\n\nFirst half here.\n\nSecond half with the quote inside.\n\nEnd.\n");
    let pos = pos_in(&old, 0, "the quote inside");
    let (change, m) = attached(carry_anchor(&old, &new, pos, "the quote inside"));
    assert_eq!(change, Change::Kept);
    assert_eq!(block_index(&new, m.pos), 2);
}

#[test]
fn test_removed_text_says_where_it_was() {
    let old = blocks_of("## One\n\nKeep this.\n\nDrop this sentence.\n\n## Two\n\nLater.\n");
    let new = blocks_of("## One\n\nKeep this.\n\n## Two\n\nLater.\n");
    let pos = pos_in(&old, 0, "Drop this");
    match carry_anchor(&old, &new, pos, "Drop this sentence.") {
        Some(Carried::Removed { pos, section, next_block }) => {
            assert_eq!(next_block, Some(2));
            assert_eq!(pos, new[2].start);
            assert_eq!(section.as_deref(), Some("one"), "the section the text was in");
        }
        other => panic!("expected removed, got {other:?}"),
    }
}

#[test]
fn test_removed_at_the_end_of_the_page() {
    let old = blocks_of("Keep.\n\nLast words.\n");
    let new = blocks_of("Keep.\n");
    match carry_anchor(&old, &new, pos_in(&old, 0, "Last"), "Last words.") {
        Some(Carried::Removed { next_block, .. }) => assert_eq!(next_block, None),
        other => panic!("expected removed, got {other:?}"),
    }
}

#[test]
fn test_stale_position_falls_back() {
    let old = blocks_of("Alpha beta.\n\nGamma delta.\n");
    let new = blocks_of("Alpha beta.\n");
    assert!(carry_anchor(&old, &new, 0, "Gamma").is_none());
}

#[test]
fn test_selection_over_two_unchanged_blocks_is_kept() {
    let old = blocks_of("Intro.\n\nalpha beta\n\ngamma delta\n");
    let new = blocks_of("New intro line.\n\nalpha beta\n\ngamma delta\n");
    let pos = pos_in(&old, 0, "beta");
    let (change, m) = attached(carry_anchor(&old, &new, pos, "beta gamma"));
    assert_eq!(change, Change::Kept);
    assert_eq!(m.pos, pos_in(&new, 0, "beta"));
}

#[test]
fn test_relocate_prefers_the_edited_quote_in_its_context_over_a_bare_copy() {
    let blocks = blocks_of(
        "Elsewhere: retry budget is five.\n\nIn last week's planning meeting we agreed the retry budget is six, per hour, for the whole team.\n",
    );
    let prefix = "nning meeting we agreed the ";
    let hit = relocate(&blocks, "retry budget is five", prefix, ", per hour, for the whole team.", None, None)
        .expect("a match");
    assert_eq!(block_index(&blocks, hit.pos), 1);
    assert!(!hit.exact);
}

#[test]
fn test_relocate_breaks_ties_by_distance() {
    let blocks = blocks_of("Same.\n\nSame.\n\nSame.\n");
    let third = blocks[2].start;
    let hit = relocate(&blocks, "Same.", "", "", None, Some(third)).expect("a match");
    assert_eq!(hit.pos, third);
}

#[test]
fn test_relocate_finds_nothing_for_missing_text() {
    let blocks = blocks_of("Nothing alike lives here at all.");
    assert!(relocate(&blocks, "bearer token", "", "", None, None).is_none());
}

#[test]
fn test_a_stretch_replaced_by_unrelated_text_is_removed() {
    let old =
        blocks_of("# API\n\nEvery route needs a token.\n\nRate limits are not enforced.\n\nTable one.\n\nTable two.\n");
    let new = blocks_of("# API\n\nA bearer key is needed.\n");
    let pos = pos_in(&old, 0, "Rate limits");
    let got = carry_anchor(&old, &new, pos, "Rate limits are not enforced");
    assert!(matches!(got, Some(Carried::Removed { next_block: Some(1), .. })), "{got:?}");
}

#[test]
fn test_a_sentence_replaced_inside_a_paragraph_hands_over_the_new_sentence() {
    let old = blocks_of("Intro.\n\nThe menu opens it. Inferred, not checked. The scan does not.\n");
    let new = blocks_of("Intro.\n\nThe menu opens it. Checked on every line today. The scan does not.\n");
    let pos = pos_in(&old, 0, "Inferred, not checked.");
    let (change, m) = attached(carry_anchor(&old, &new, pos, "Inferred, not checked."));
    assert_eq!(change, Change::Rewritten);
    assert_eq!(m.quote, "Checked on every line today.");
}

#[test]
fn test_a_sentence_deleted_from_a_paragraph_that_stays_is_removed_there() {
    let old = blocks_of("Intro.\n\nThe menu opens it. Delete this sentence please. The scan does not.\n");
    let new = blocks_of("Intro.\n\nThe menu opens it. The scan does not.\n");
    let pos = pos_in(&old, 0, "Delete this");
    match carry_anchor(&old, &new, pos, "Delete this sentence please.") {
        Some(Carried::Removed { pos, next_block, .. }) => {
            assert_eq!(next_block, Some(1));
            assert!(pos > new[1].start, "the spot is inside the paragraph");
        }
        other => panic!("expected removed, got {other:?}"),
    }
}
