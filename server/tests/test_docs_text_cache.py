"""The headings and prose lines of a page are parsed once per text and shared, without a caller able to change them."""

from services import docs_text


def test_headings_are_parsed_once_and_each_caller_gets_its_own_copy():
    md = "# Title\n\n## Setup\n\ntext\n\n## Setup\n\n```\n## not a heading\n```\n"
    docs_text._headings_short.cache_clear()
    first = docs_text.heading_anchors(md)
    assert [h["slug"] for h in first] == ["title", "setup", "setup-2"]
    first[0]["slug"] = "changed"
    first.append({"slug": "extra"})
    again = docs_text.heading_anchors(md)
    assert [h["slug"] for h in again] == ["title", "setup", "setup-2"]
    assert docs_text._headings_short.cache_info().hits >= 1


def test_page_references_come_from_the_shared_parse():
    md = "## Intro\n\nSee [[Spec]] and [[Plan#Goals]].\n"
    docs_text._prose_lines_short.cache_clear()
    refs = docs_text.page_ref_contexts(md)
    assert [(r["title"], r["section"]) for r in refs] == [
        ("Spec", "intro"),
        ("Plan", "intro"),
    ]
    assert docs_text.page_ref_contexts(md, {"plan"})[0]["anchor"] == "Goals"
    assert docs_text._prose_lines_short.cache_info().hits >= 1


def test_many_short_texts_do_not_push_a_page_out_of_the_cache():
    """Reading the tickets that mention a page parses hundreds of comments: the page stays parsed."""
    page = "# Spec\n\n" + "".join(
        f"## Part {i}\n\nSee [[Plan]].\n\n" for i in range(200)
    )
    assert len(page) >= docs_text.SHORT_TEXT
    docs_text._prose_lines_cached.cache_clear()
    docs_text.page_ref_contexts(page)
    for i in range(500):
        docs_text.page_ref_contexts(f"Comment {i}: see [[Spec]].")
    docs_text.page_ref_contexts(page)
    assert docs_text._prose_lines_cached.cache_info().hits >= 1
