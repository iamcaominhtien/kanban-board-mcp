"""Comment anchors: turn page Markdown into plain text blocks and re-find a quoted selection in them.

An anchor is the selected text (``quote``) plus up to ``CONTEXT`` characters of ``prefix`` / ``suffix``
from the same block and the id of the section it sits in. The page Markdown is never changed.
"""

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from services.docs_text import heading_anchors, strip_block_prefix

CONTEXT = 32
MIN_FUZZY_RATIO = 0.7
MIN_FUZZY_QUOTE = 4
MAX_QUOTE = 500

_WS = re.compile(r"\s+")
_FENCE = re.compile(r"^\s*(```|~~~)")
_IMAGE = re.compile(r"!\[[^\]\n]{0,300}\]\([^()\n]{0,500}\)")
_LINK = re.compile(r"\[([^\][\n]{1,300})\]\(([^()\n]{0,500})\)")
_REF = re.compile(
    r"\[\[([^\][|#\n]{1,200})(?:#[^\][|\n]{0,200})?(?:\|([^\][\n]{1,200}))?\]\]"
)
_EMPHASIS = re.compile(r"(\*\*|__|~~|\*|`)")
_UNDERSCORE = re.compile(r"(?<![\w])_([^_\n]{1,300})_(?![\w])")
_HTML = re.compile(r"</?[a-zA-Z][^>\n]{0,200}>")


def normalize(text: str) -> str:
    """Collapse whitespace runs to single spaces and trim, the way a selection is compared."""
    return _WS.sub(" ", text).strip()


@dataclass
class Block:
    """One block of page text (paragraph, heading, list item, table cell or code block)."""

    text: str
    section: str | None
    start: int  # offset of the block in the page text, blocks joined by a newline


@dataclass
class Match:
    """Where an anchor was found, with the anchor refreshed to the text found there."""

    pos: int
    quote: str
    prefix: str
    suffix: str
    section: str | None
    exact: bool


def _inline_plain(line: str) -> str:
    line = _IMAGE.sub("", line)
    line = _LINK.sub(lambda m: m.group(1), line)
    line = _REF.sub(lambda m: m.group(2) or m.group(1), line)
    line = _HTML.sub("", line)
    line = _UNDERSCORE.sub(lambda m: m.group(1), line)
    line = _EMPHASIS.sub("", line)
    line = re.sub(r"\\([\\`*_{}\[\]()#+\-.!|>~$])", r"\1", line)
    return normalize(line)


def blocks_of(markdown: str) -> list[Block]:
    """Split Markdown into plain-text blocks, each tagged with the heading slug it sits under.

    Args:
        markdown: Page Markdown.

    Returns:
        Non-empty blocks in page order; ``start`` offsets index the blocks joined by newlines.
    """
    slugs = [h["slug"] for h in heading_anchors(markdown)]
    seen_headings = 0
    out: list[tuple[str, str | None]] = []
    para: list[str] = []
    code: list[str] = []
    in_code = False
    section: str | None = None

    def flush() -> None:
        if para:
            text = _inline_plain(" ".join(para))
            if text:
                out.append((text, section))
            para.clear()

    for raw in markdown.split("\n"):
        if _FENCE.match(raw):
            if in_code:
                text = normalize(" ".join(code))
                if text:
                    out.append((text, section))
                code.clear()
            else:
                flush()
            in_code = not in_code
            continue
        if in_code:
            code.append(raw)
            continue
        if not raw.strip():
            flush()
            continue
        if re.match(r"^\s{0,3}#{1,6}[ \t]", raw):
            flush()
            if seen_headings < len(slugs):
                section = slugs[seen_headings]
                seen_headings += 1
            text = _inline_plain(strip_block_prefix(raw, headings=True))
            if text:
                out.append((text, section))
            continue
        if raw.lstrip().startswith("|"):
            flush()
            if not raw.strip(" \t|:-"):  # a |---|---| separator row
                continue
            for cell in raw.strip().strip("|").split("|"):
                text = _inline_plain(cell)
                if text:
                    out.append((text, section))
            continue
        if re.match(r"^\s*([*+-]|\d{1,9}\.)[ \t]", raw) or raw.lstrip().startswith(">"):
            flush()
            text = _inline_plain(strip_block_prefix(raw))
            if text:
                out.append((text, section))
            continue
        para.append(raw)
    flush()
    blocks: list[Block] = []
    pos = 0
    for text, sec in out:
        blocks.append(Block(text=text, section=sec, start=pos))
        pos += len(text) + 1
    return blocks


def context_of(text: str, start: int, end: int) -> tuple[str, str]:
    """Return the prefix and suffix around ``text[start:end]`` (at most ``CONTEXT`` characters each)."""
    return text[max(0, start - CONTEXT) : start], text[end : end + CONTEXT]


def _common_suffix(a: str, b: str) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def _common_prefix(a: str, b: str) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def _score(
    block: Block, at: int, end: int, prefix: str, suffix: str, section: str | None
) -> float:
    before, after = context_of(block.text, at, end)
    score = float(_common_suffix(before, prefix) + _common_prefix(after, suffix))
    if section is not None and block.section == section:
        score += 0.5
    return score


def _found(block: Block, at: int, end: int, exact: bool) -> Match:
    prefix, suffix = context_of(block.text, at, end)
    return Match(
        pos=block.start + at,
        quote=block.text[at:end],
        prefix=prefix,
        suffix=suffix,
        section=block.section,
        exact=exact,
    )


def find_anchor(
    blocks: list[Block],
    quote: str,
    prefix: str = "",
    suffix: str = "",
    section: str | None = None,
) -> Match | None:
    """Find a quote in the page blocks.

    An exact occurrence wins (the best-scoring one by surrounding text and section when there are
    several). Failing that, the closest block text with at least ``MIN_FUZZY_RATIO`` of the quote
    still in place counts, so a slightly edited or moved selection stays attached.

    Args:
        blocks: Output of ``blocks_of``.
        quote: Selected text, whitespace-normalized.
        prefix: Text that preceded the selection.
        suffix: Text that followed the selection.
        section: Slug of the section the selection was in.

    Returns:
        The match, or None when nothing is close enough.
    """
    quote = normalize(quote)
    if not quote:
        return None
    best: tuple[float, Block, int] | None = None
    for block in blocks:
        at = block.text.find(quote)
        while at != -1:
            s = _score(block, at, at + len(quote), prefix, suffix, section)
            if best is None or s > best[0]:
                best = (s, block, at)
            at = block.text.find(quote, at + 1)
    if best:
        _, block, at = best
        return _found(block, at, at + len(quote), True)
    if len(quote) < MIN_FUZZY_QUOTE:
        return None
    fuzzy: tuple[float, Block, int, int] | None = None
    for block in blocks:
        sm = SequenceMatcher(None, quote, block.text, autojunk=False)
        parts = [m for m in sm.get_matching_blocks() if m.size]
        if not parts:
            continue
        covered = sum(m.size for m in parts)
        ratio = covered / len(quote)
        if ratio < MIN_FUZZY_RATIO:
            continue
        at, end = parts[0].b, parts[-1].b + parts[-1].size
        if end - at > len(quote) * 2 + 10:
            continue
        s = ratio * 100 + _score(block, at, end, prefix, suffix, section)
        if fuzzy is None or s > fuzzy[0]:
            fuzzy = (s, block, at, end)
    if fuzzy:
        _, block, at, end = fuzzy
        return _found(block, at, end, False)
    return None
