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
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_REF = re.compile(r"\[\[([^\]\|#]+?)(?:#([^\]\|]+?))?(?:\|([^\]]+?))?\]\]")
_TICKET = re.compile(r"\b([A-Z][A-Z0-9]{1,5}-\d+)\b")
_INLINE_CODE = re.compile(r"`[^`\n]*`")


def slugify(text: str) -> str:
    """Lower-case, spaces to dashes, punctuation dropped (``Example request`` -> ``example-request``)."""
    slug = re.sub(r"[^\w\s-]", "", text.lower(), flags=re.UNICODE)
    slug = re.sub(r"[\s_]+", "-", slug.strip())
    return re.sub(r"-{2,}", "-", slug).strip("-")


def _strip_inline(text: str) -> str:
    text = re.sub(
        r"\[\[([^\]\|#]+?)(?:#[^\]\|]+?)?(?:\|([^\]]+?))?\]\]",
        lambda m: m.group(2) or m.group(1),
        text,
    )
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
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
        snippet = re.sub(
            r"^\s*(?:>\s*)*(?:[*+-]|\d+\.)?\s*(?:\[[ xX]\]\s*)?", "", _strip_inline(raw)
        )[:160]
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


def rewrite_page_links(markdown: str, old_title: str, new_title: str) -> tuple[str, int]:
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
        out.append(raw if in_fence else _map_outside_code(raw, lambda t: _REF.sub(sub, t)))
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
