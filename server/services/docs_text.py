"""Pure Markdown helpers for the Docs space: slugs, headings and reference parsing."""

import re
from typing import Any


class DocsError(Exception):
    """Domain error carrying an HTTP status and a machine-readable code."""

    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


_FENCE = re.compile(r"^\s*(```|~~~)")
# Patterns below are linear on hostile input: body classes exclude the next opener ("[") and are
# length-bounded, so one unanchored scan never rescans the rest of the text from every start.
_REF = re.compile(r"\[\[([^\][|#\n]{1,200})(?:#([^\][|\n]{1,200}))?(?:\|([^\][\n]{1,200}))?\]\]")
_LINK = re.compile(r"\[([^\][\n]{1,300})\]\(([^()\n]{0,500})\)")
_BULLET = re.compile(r"(?:[*+-]|\d{1,9}\.)[ \t]*")
_CHECKBOX = re.compile(r"\[[ xX]\][ \t]*")


class _HeadingMatch:
    """Just enough of ``re.Match`` for the callers: ``group(1)`` = hashes, ``group(2)`` = text."""

    def __init__(self, hashes: str, text: str) -> None:
        self._groups = (hashes, text)

    def group(self, i: int) -> str:
        return self._groups[i - 1]


class _HeadingMatcher:
    """ATX heading (``## Title ##``) without a regex: no backtracking on odd whitespace / ``#`` runs."""

    @staticmethod
    def match(line: str) -> "_HeadingMatch | None":
        n = 0
        while n < len(line) and n < 7 and line[n] == "#":
            n += 1
        if n < 1 or n > 6 or n >= len(line) or line[n] not in " \t":
            return None
        text = line[n:].strip()
        bare = text.rstrip("#")
        if bare != text and (not bare or bare[-1] in " \t"):
            text = bare.rstrip()  # a closing run of # counts only after a space
        return _HeadingMatch(line[:n], text) if text else None


_HEADING = _HeadingMatcher()


def strip_block_prefix(line: str, headings: bool = False) -> str:
    """Drop quote markers, list bullet / number (or ``#`` run) and a task checkbox from the start of a line."""
    line = line.lstrip(" \t>")
    while line.startswith(">"):  # "> > x" and ">  > x"
        line = line[1:].lstrip(" \t>")
    if headings:
        hashes = len(line) - len(line.lstrip("#"))
        if 1 <= hashes <= 6:
            line = line[hashes:].lstrip(" \t")
        else:
            line = _BULLET.sub("", line, count=1) if _BULLET.match(line) else line
    elif _BULLET.match(line):
        line = _BULLET.sub("", line, count=1)
    if _CHECKBOX.match(line):
        line = _CHECKBOX.sub("", line, count=1)
    return line
_TICKET = re.compile(r"\b([A-Z][A-Z0-9]{1,5}-\d+)\b")
_INLINE_CODE = re.compile(r"`[^`\n]*`")


def slugify(text: str) -> str:
    """Lower-case, spaces to dashes, punctuation dropped (``Example request`` -> ``example-request``)."""
    slug = re.sub(r"[^\w\s-]", "", text.lower(), flags=re.UNICODE)
    slug = re.sub(r"[\s_]+", "-", slug.strip())
    return re.sub(r"-{2,}", "-", slug).strip("-")


def _strip_inline(text: str) -> str:
    text = _REF.sub(lambda m: m.group(3) or m.group(1), text)
    text = _LINK.sub(r"\1", text)
    return re.sub(r"[*_`~]", "", text).strip()


def heading_anchors(markdown: str) -> list[dict[str, Any]]:
    """Headings with their slug anchors; duplicates get ``-2``, ``-3``…"""
    out: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    in_fence = False
    for line in markdown.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING.match(line)
        if not m:
            continue
        text = _strip_inline(m.group(2))
        base = slugify(text) or "section"
        count = seen.get(base, 0) + 1
        seen[base] = count
        slug = base if count == 1 else f"{base}-{count}"
        out.append({"level": len(m.group(1)), "text": text, "slug": slug})
    return out


def _prose_lines(markdown: str) -> list[tuple[str, str | None, str]]:
    """(line, current section slug, raw line) for lines outside code fences."""
    anchors = {a["text"]: a["slug"] for a in heading_anchors(markdown)}
    section: str | None = None
    in_fence = False
    out: list[tuple[str, str | None, str]] = []
    for raw in markdown.splitlines():
        if _FENCE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING.match(raw)
        if m:
            section = anchors.get(_strip_inline(m.group(2)), section)
        out.append((_INLINE_CODE.sub("", raw), section, raw))
    return out


def parse_references(markdown: str) -> list[dict[str, Any]]:
    """Every [[page]] and ticket-key reference with its section and a context snippet."""
    refs: list[dict[str, Any]] = []
    for line, section, raw in _prose_lines(markdown):
        snippet = strip_block_prefix(_strip_inline(raw))[:160]
        for m in _REF.finditer(line):
            refs.append(
                {
                    "kind": "page",
                    "title": m.group(1).strip(),
                    "anchor": (m.group(2) or "").strip() or None,
                    "display": (m.group(3) or "").strip() or None,
                    "section": section,
                    "snippet": snippet,
                }
            )
        stripped = _REF.sub("", line)
        for m in _TICKET.finditer(stripped):
            refs.append(
                {
                    "kind": "ticket",
                    "key": m.group(1),
                    "section": section,
                    "snippet": snippet,
                }
            )
    return refs


def sentence_around(raw: str, needle: str, limit: int = 200) -> str:
    """The sentence of ``raw`` that contains ``needle`` (plain text, markdown noise removed)."""
    plain_line = re.sub(
        r"^\s*(?:>\s*)*(?:[*+-]|\d+\.)?\s*(?:\[[ xX]\]\s*)?", "", raw.strip()
    )
    pos = plain_line.find(needle)
    if pos < 0:
        return _strip_inline(plain_line)[:limit]
    start = 0
    for m in re.finditer(r"(?<=[.!?])\s+", plain_line[:pos]):
        start = m.end()
    end_m = re.search(r"(?<=[.!?])\s", plain_line[pos + len(needle) :])
    end = pos + len(needle) + end_m.start() + 1 if end_m else len(plain_line)
    return _strip_inline(plain_line[start:end])[:limit]


def _map_outside_code(line: str, fn: Any) -> str:
    out, last = [], 0
    for m in _INLINE_CODE.finditer(line):
        out.append(fn(line[last : m.start()]))
        out.append(m.group(0))
        last = m.end()
    out.append(fn(line[last:]))
    return "".join(out)


def rewrite_page_links(
    markdown: str, old_title: str, new_title: str
) -> tuple[str, int]:
    """Point ``[[Old]]``, ``[[Old#S]]`` and ``[[Old|label]]`` at ``new_title`` (code is left alone)."""
    needle = old_title.strip().lower()
    count = 0

    def sub(m: re.Match[str]) -> str:
        nonlocal count
        if m.group(1).strip().lower() != needle:
            return m.group(0)
        count += 1
        anchor = f"#{m.group(2)}" if m.group(2) is not None else ""
        label = f"|{m.group(3)}" if m.group(3) is not None else ""
        return f"[[{new_title}{anchor}{label}]]"

    out: list[str] = []
    in_fence = False
    for raw in markdown.split("\n"):
        if _FENCE.match(raw):
            in_fence = not in_fence
            out.append(raw)
            continue
        out.append(
            raw if in_fence else _map_outside_code(raw, lambda t: _REF.sub(sub, t))
        )
    return "\n".join(out), count


def count_page_links(markdown: str, title: str) -> int:
    return rewrite_page_links(markdown, title, title)[1]


def page_ref_contexts(markdown: str) -> list[dict[str, Any]]:
    """Every [[page]] reference with the sentence it sits in (for 'Referenced by' and ticket mentions)."""
    out: list[dict[str, Any]] = []
    for line, section, _raw in _prose_lines(markdown):
        for m in _REF.finditer(line):
            out.append(
                {
                    "title": m.group(1).strip(),
                    "anchor": (m.group(2) or "").strip() or None,
                    "section": section,
                    "context": sentence_around(line, m.group(0)),
                }
            )
    return out
