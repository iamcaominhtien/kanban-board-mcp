"""From a page's checklist to tickets: unchecked task items and action items ("TODO:" lines, bullets under an "Actions"
or "Next steps" heading) become tickets. Ticked items and items that already carry a ticket key are left out.

Deterministic: no model. docs_write(action='tickets') uses it (kanban_mcp/tools/docs.py). Kept from the Docs AI of v1
(services/docs_ai/tickets.py) when the Docs AI moved to Claude Code skills (AI v2).
"""

import re
from dataclasses import dataclass, field
from typing import Any

from services.docs_text import _FENCE, _HEADING, _TICKET, strip_block_prefix
from services.docs_text import _strip_inline as plain_inline

MAX_ITEMS = 30

_TASK = re.compile(r"^\s*(?:>\s*)*(?:[*+-]|\d{1,9}\.)\s+\[( |x|X)\][ \t]+(\S.*)$")
_BULLET = re.compile(r"^\s*(?:>\s*)*(?:[*+-]|\d{1,9}\.)\s+(\S.*)$")
_ACTION_HEAD = re.compile(r"action|next steps?|to-?do|follow-?ups?", re.I)
_ACTION_PREFIX = re.compile(
    r"^\s*(?:(?:[*+-]|\d{1,9}\.)\s+)?(?:todo|action(?: item)?)\s*[:\-]\s*(\S.*)$", re.I
)
_INLINE_CODE = re.compile(r"`[^`\n]*`")
_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_MONTHS = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
]
_DUE_DAY = re.compile(
    r"\b(?:due|by)\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b", re.I
)
_DUE_ISO = re.compile(r"\b(?:due|by)\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})\b", re.I)
_DUE_MONTH = re.compile(
    r"\b(?:due|by)\s+(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b",
    re.I,
)
_DUE_REL = re.compile(r"\b(?:due|by)\s+(today|tomorrow)\b", re.I)
_DUE_ANY = re.compile(
    r",?\s*\b(?:due|by)\s+(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|\d{4}-\d{2}-\d{2}"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|today|tomorrow)\b",
    re.I,
)
_NAME_TAIL = re.compile(r"\s+[—–-]\s+[A-Z][\w'’]*(?:\s+[A-Z][\w'’]*){0,2}\s*$")


@dataclass
class Found:
    """What was found on a page: items to draft and items left out (with the reason)."""

    items: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)


def line_text(raw: str) -> str:
    """The plain text of a list line: no bullet, checkbox or formatting (what a draft's `text` holds)."""
    return plain_inline(strip_block_prefix(raw)).strip()


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def extract(markdown: str, selection: str | None = None) -> Found:
    """Unchecked task items and action items of some Markdown, skipping ticked items and items that already carry a
    ticket key (a chip). `selection` limits the search to the text a person selected."""
    found = Found()
    lines = markdown.splitlines()
    wanted = _norm(selection) if selection and selection.strip() else None
    if wanted:
        picked = [
            i
            for i, ln in enumerate(lines)
            if line_text(ln) and _norm(line_text(ln)) in wanted
        ]
        if not picked:
            lines, wanted = (
                selection.splitlines(),
                None,
            )  # the selection is not on the page: read it as Markdown
    in_fence = False
    heading = ""
    for i, raw in enumerate(lines):
        if _FENCE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        h = _HEADING.match(raw)
        if h:
            heading = h.group(2)
            continue
        if wanted is not None and (
            not line_text(raw) or _norm(line_text(raw)) not in wanted
        ):
            continue
        task = _TASK.match(raw)
        checked = False
        if task:
            checked = task.group(1).lower() == "x"
        else:
            pre = _ACTION_PREFIX.match(raw)
            if pre is None and not (
                _ACTION_HEAD.search(heading) and _BULLET.match(raw)
            ):
                continue
        text = line_text(raw)
        if not text:
            continue
        if checked:
            found.skipped.append({"text": text, "reason": "ticked", "line": i})
            continue
        key = _TICKET.search(_INLINE_CODE.sub("", raw))
        if key:
            found.skipped.append(
                {"text": text, "reason": "has_ticket", "key": key.group(1), "line": i}
            )
            continue
        found.items.append({"text": text, "raw": raw, "line": i})
    for n, it in enumerate(found.items[:MAX_ITEMS], start=1):
        it["n"] = n
    found.items = found.items[:MAX_ITEMS]
    return found


def clean_title(text: str) -> str:
    """The text as a ticket title: no due phrase, no "— Name" tail, no "TODO:" prefix, first letter capital."""
    title = _ACTION_PREFIX.sub(r"\1", text).strip()
    title = _DUE_ANY.sub("", title).strip(" ,;")
    title = _NAME_TAIL.sub("", title).strip(" ,;—–-")
    title = title or text.strip()
    return (title[:1].upper() + title[1:])[:200]
