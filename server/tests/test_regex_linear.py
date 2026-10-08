"""The docs / mention / search patterns stay linear on hostile input (CodeQL polynomial-regex findings)."""

import time

import pytest

from services import docs_search
from services.docs_text import (
    _HEADING,
    _strip_inline,
    heading_anchors,
    page_ref_contexts,
    parse_references,
    strip_block_prefix,
)
from services.tickets import mention_ids

HOSTILE = [
    "[[" * 25_000,
    '[["#' * 12_500,
    "[x](" * 12_500,
    "@[" * 25_000,
    "@[a](member:" * 5_000,
    " " * 50_000 + "x",
    "/" * 50_000 + "a",
    "## " + "#" * 50_000 + " x",
    "- " + " " * 50_000,
]


@pytest.mark.parametrize("text", HOSTILE)
def test_hostile_input_is_fast(text):
    start = time.perf_counter()
    _strip_inline(text)
    parse_references(text)
    page_ref_contexts(text)
    heading_anchors(text)
    strip_block_prefix(text)
    strip_block_prefix(text, headings=True)
    mention_ids(text)
    docs_search._trim_nonword(text)
    _HEADING.match(text)
    assert time.perf_counter() - start < 2.0


def test_reference_forms_still_parse():
    refs = parse_references("See [[A]], [[A#B]] and [[A#B|label]] and KAN-12.")
    pages = [
        (r["title"], r["anchor"], r["display"]) for r in refs if r["kind"] == "page"
    ]
    assert pages == [("A", None, None), ("A", "B", None), ("A", "B", "label")]
    assert [r["key"] for r in refs if r["kind"] == "ticket"] == ["KAN-12"]
    assert _strip_inline("a [[P#S|shown]] and [t](http://x) b") == "a shown and t b"


def test_heading_forms():
    h = _HEADING.match
    assert h("## Title").group(2) == "Title" and h("## Title").group(1) == "##"
    assert h("## Title ##").group(2) == "Title"
    assert h("## C#").group(2) == "C#"
    assert h("#Title") is None and h("####### seven") is None and h("##   ") is None
    assert [a["slug"] for a in heading_anchors("# One\n## One\n```\n# no\n```")] == [
        "one",
        "one-2",
    ]


def test_block_prefix_and_trim_and_mentions():
    assert strip_block_prefix("- [x] see [[A]]") == "see [[A]]"
    assert strip_block_prefix("> 1. item") == "item"
    assert strip_block_prefix("## Head", headings=True) == "Head"
    assert docs_search._trim_nonword('--"hello world"!') == "hello world"
    assert mention_ids("hi @[Linh Pham](member:abc-123) and @[X](member:abc-123)") == [
        "abc-123"
    ]
