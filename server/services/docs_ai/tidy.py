"""Tidy while importing Markdown (design/screens/docs-ai.md, D4).

Deterministic, so it costs nothing and needs no model: split by top-level heading, count ticket keys (the chips render
from the text, so keys stay as text), find "see X" phrases that name an existing page, and move headings so the page
starts at `##`. "see X" links are candidates for review: they are only written into the text when the person accepts
them (`accept_see_links`). Nothing is imported here: the result is a preview, "what changed in each page", and the
files the existing import endpoint takes.
"""

import re
from collections import Counter
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsPage, Ticket
from services.docs_text import _FENCE, _HEADING, _TICKET, slugify

from . import settings as svc_settings
from .errors import DocsAiError

MAX_MARKDOWN = 2 * 1024 * 1024
_SEE = re.compile(
    r"\b([Ss]ee)\s+(?:the\s+)?(?:\[\[[^\]\n]*\]\]|[“\"']?([A-Za-z0-9][A-Za-z0-9 ›>/_-]{0,80}?)[”\"']?(?=[.,;:)!?]|\s*$|\s+(?:for|in|on|and|or|to|page|section)\b))"
)
_INLINE_CODE = re.compile(r"`[^`\n]*`")


def _lines_outside_code(lines: list[str]) -> list[bool]:
    """True per line when it is prose (not inside a fenced code block)."""
    out, fenced = [], False
    for line in lines:
        if _FENCE.match(line):
            fenced = not fenced
            out.append(False)
        else:
            out.append(not fenced)
    return out


def split_sections(markdown: str) -> tuple[str, list[tuple[str, str]], int]:
    """`(preamble, [(heading text, body)], level)`: the text split at the top-level headings.

    A lone top heading is the document's title: the sections are then the next level down.
    """
    lines = markdown.split("\n")
    prose = _lines_outside_code(lines)
    heads = [
        (i, len(m.group(1)), m.group(2))
        for i, line in enumerate(lines)
        if prose[i] and (m := _HEADING.match(line))
    ]
    if not heads:
        return markdown, [], 0
    level = min(h[1] for h in heads)
    tops = [h for h in heads if h[1] == level]
    title_line: int | None = None
    if len(tops) == 1 and any(h[1] == level + 1 for h in heads):
        title_line = tops[0][0]
        level += 1
        tops = [h for h in heads if h[1] == level]
    if len(tops) < 2 and title_line is None:
        return markdown, [], level
    first = tops[0][0]
    pre_start = (title_line + 1) if title_line is not None else 0
    preamble = "\n".join(lines[pre_start:first]).strip()
    sections = []
    for k, (i, _lvl, text) in enumerate(tops):
        end = tops[k + 1][0] if k + 1 < len(tops) else len(lines)
        sections.append((text, "\n".join(lines[i + 1 : end]).strip("\n")))
    return preamble, sections, level


def shift_headings(markdown: str, minimum: int = 2) -> tuple[str, int]:
    """Move every heading so the shallowest one is `minimum` deep: `(text, levels moved)`."""
    lines = markdown.split("\n")
    prose = _lines_outside_code(lines)
    levels = [
        len(m.group(1))
        for i, line in enumerate(lines)
        if prose[i] and (m := _HEADING.match(line))
    ]
    if not levels or min(levels) >= minimum:
        return markdown, 0
    shift = minimum - min(levels)
    for i, line in enumerate(lines):
        if prose[i] and (m := _HEADING.match(line)):
            lines[i] = "#" * min(6, len(m.group(1)) + shift) + " " + m.group(2)
    return "\n".join(lines), shift


def ticket_keys(markdown: str) -> Counter[str]:
    """Ticket keys written in prose (not in code), counted."""
    lines = markdown.split("\n")
    prose = _lines_outside_code(lines)
    found: Counter[str] = Counter()
    for i, line in enumerate(lines):
        if prose[i]:
            found.update(_TICKET.findall(_INLINE_CODE.sub("", line)))
    return found


def see_candidates(markdown: str, titles: dict[str, str]) -> list[dict[str, Any]]:
    """ "see X" phrases whose X is the title of a page: `[{id, line, phrase, title}]` (`titles`: lower-cased -> title)."""
    lines = markdown.split("\n")
    prose = _lines_outside_code(lines)
    out = []
    for i, line in enumerate(lines):
        if not prose[i]:
            continue
        clean = _INLINE_CODE.sub(lambda m: " " * len(m.group(0)), line)
        for m in _SEE.finditer(clean):
            name = (m.group(2) or "").strip()
            title = titles.get(name.lower())
            if title:
                out.append(
                    {
                        "id": f"l{i + 1}c{m.start(2)}",
                        "line": i + 1,
                        "phrase": m.group(0),
                        "title": title,
                        "start": m.start(2),
                        "end": m.start(2) + len(m.group(2)),
                    }
                )
    return out


def apply_see_links(
    markdown: str, accepted: set[str], candidates: list[dict[str, Any]]
) -> str:
    """Write `[[Title]]` in place of the accepted candidates' page names."""
    lines = markdown.split("\n")
    for c in sorted(candidates, key=lambda c: (c["line"], -c["start"])):
        if c["id"] not in accepted:
            continue
        i = c["line"] - 1
        line = lines[i]
        start = c["start"]
        # take a quote around the name with it
        if start > 0 and line[start - 1] in "“\"'":
            start -= 1
        end = c["end"]
        if end < len(line) and line[end] in "”\"'":
            end += 1
        lines[i] = line[:start] + f"[[{c['title']}]]" + line[end:]
    return "\n".join(lines)


def _file_for(title: str, body: str, taken: set[str]) -> dict[str, str]:
    """The upload the import endpoint takes: front matter carries the title."""
    base = slugify(title) or "page"
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    taken.add(name)
    safe_title = title.replace('"', "'")
    return {
        "path": f"{name}.md",
        "content": f'---\ntitle: "{safe_title}"\n---\n\n{body.strip()}\n',
    }


async def tidy(
    session: AsyncSession,
    project_id: str,
    markdown: str,
    options: dict[str, Any],
    *,
    filename: str = "import.md",
    accept_see_links: list[str] | None = None,
) -> dict[str, Any]:
    """Preview the tidied import: pages (with what changed in each), counts and the "see X" candidates.

    Args:
        markdown: The file's text.
        options: `{split_by_heading, ticket_chips, see_links, heading_levels}`.
        filename: Used for the title of a page with no heading.
        accept_see_links: Candidate ids the person accepted; the rest stay plain text.
    """
    await svc_settings.require_enabled(session, project_id)
    if len(markdown.encode("utf-8")) > MAX_MARKDOWN:
        raise DocsAiError("too_long", "That file is larger than 2 MB.")
    text = markdown.replace("\r\n", "\n").replace("\r", "\n")
    opts = {
        k: bool(options.get(k))
        for k in ("split_by_heading", "ticket_chips", "see_links", "heading_levels")
    }
    stem = (
        re.sub(r"\.(md|markdown)$", "", filename.rsplit("/", 1)[-1], flags=re.I)
        or "Import"
    )
    doc_title = stem.replace("-", " ").replace("_", " ").strip().title() or "Import"

    sections: list[tuple[str, str]] = []
    preamble, level = text, 0
    if opts["split_by_heading"]:
        preamble, sections, level = split_sections(text)
    pieces: list[tuple[str, str, list[str]]] = []  # (title, body, changes)
    if sections:
        if preamble.strip():
            pieces.append(
                (
                    doc_title,
                    preamble,
                    [f"Text before the first section, from {filename}"],
                )
            )
        for title, body in sections:
            pieces.append((title, body, [f"Split from {filename}"]))
    else:
        pieces.append((doc_title, text, []))

    existing = {
        p.title.lower(): p.title
        for p in (
            await session.exec(
                select(DocsPage).where(
                    DocsPage.project_id == project_id,
                    col(DocsPage.deleted_at).is_(None),
                )
            )
        ).all()
    }
    for title, _b, _c in pieces:  # pages this import makes can be linked to as well
        existing.setdefault(title.lower(), title)

    accepted = set(accept_see_links or [])
    pages: list[dict[str, Any]] = []
    all_keys: Counter[str] = Counter()
    candidates_out: list[dict[str, Any]] = []
    taken: set[str] = set()
    for idx, (title, body, changes) in enumerate(pieces):
        changes = list(changes)
        if opts["heading_levels"]:
            body, moved = shift_headings(body)
            if moved:
                changes.append(
                    f"Headings moved down {moved} level{'s' if moved != 1 else ''}, starting at ##"
                )
        keys = ticket_keys(body)
        all_keys.update(keys)
        if opts["ticket_chips"] and keys:
            changes.append(
                "Ticket keys kept as text and shown as chips: "
                + ", ".join(f"{k} ×{n}" for k, n in keys.most_common(6))
            )
        cands = [
            {**c, "page_index": idx, "page_title": title, "id": f"p{idx}{c['id']}"}
            for c in see_candidates(
                body,
                {k: v for k, v in existing.items() if v.lower() != title.lower()},
            )
        ]
        mine = (
            {c["id"] for c in cands if c["id"] in accepted}
            if opts["see_links"]
            else set()
        )
        if mine:
            local = [{**c, "id": c["id"][len(f"p{idx}") :]} for c in cands]
            body = apply_see_links(body, {m[len(f"p{idx}") :] for m in mine}, local)
            changes.append(f"{len(mine)} “see …” turned into [[links]]")
        for c in cands:
            candidates_out.append(
                {
                    "id": c["id"],
                    "page_index": idx,
                    "page_title": title,
                    "line": c["line"],
                    "phrase": c["phrase"],
                    "title": c["title"],
                    "accepted": c["id"] in accepted,
                }
            )
        if not changes:
            changes.append("No changes")
        pages.append(
            {
                "index": idx,
                "title": title,
                "markdown": body,
                "changes": changes,
                "file": _file_for(title, body, taken),
            }
        )

    known = set()
    if all_keys:
        known = set(
            (
                await session.exec(
                    select(Ticket.id).where(
                        Ticket.project_id == project_id,
                        col(Ticket.id).in_(list(all_keys)),
                    )
                )
            ).all()
        )
    return {
        "options": opts,
        "source": {
            "filename": filename,
            "bytes": len(markdown.encode("utf-8")),
            "sections": len(split_sections(text)[1]) or 1,
            "split_level": level,
        },
        "counts": {
            "pages": len(pages),
            "ticket_keys": [
                {"key": k, "count": n, "known": k in known}
                for k, n in all_keys.most_common()
            ],
            "ticket_key_total": sum(all_keys.values()),
            "see_links": len(candidates_out),
        },
        "see_links": candidates_out,
        "pages": pages,
        "cost": 0,
    }
