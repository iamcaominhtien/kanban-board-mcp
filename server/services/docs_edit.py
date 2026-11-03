"""Edit a part of a Docs page instead of the whole page: one section, or one passage.

Pure functions over the page's Markdown, so an AI fixes one line of a long page without sending the page back (and
without overwriting what a person changed elsewhere in the meantime). The MCP action `docs_write(edit)` reads the
page, applies the edits here, and publishes the result as one new version through the usual `update` path.

Safety: a passage edit names the exact text it replaces, so it fails when that text changed. A section edit made
from an older `base_version` goes on only when that section still reads as it did in that version.
"""

from dataclasses import dataclass
from typing import Any

from services.docs_text import _FENCE, _HEADING, _strip_inline, slugify

MODES = ("replace", "append", "prepend", "before", "after")


class EditError(ValueError):
    """An edit that cannot be applied as asked; the message says how to fix the call."""


@dataclass
class Section:
    """A heading and the lines it owns (up to the next heading of the same or a higher level)."""

    level: int
    text: str
    slug: str
    start: int  # line index of the heading
    end: int  # line index after the section's last line (sub-sections included)


def sections(markdown: str) -> list[Section]:
    """The page's sections in order, with the same slugs as `heading_anchors` (duplicates get -2, -3…)."""
    lines = markdown.split("\n")
    found: list[tuple[int, int, str]] = []
    in_fence = False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING.match(line)
        if m:
            found.append((i, len(m.group(1)), _strip_inline(m.group(2))))
    out: list[Section] = []
    seen: dict[str, int] = {}
    for n, (i, level, text) in enumerate(found):
        end = len(lines)
        for j, lvl, _ in found[n + 1 :]:
            if lvl <= level:
                end = j
                break
        base = slugify(text) or "section"
        count = seen.get(base, 0) + 1
        seen[base] = count
        slug = base if count == 1 else f"{base}-{count}"
        out.append(Section(level, text, slug, i, end))
    return out


def _key(name: str) -> str:
    name = name.strip().lstrip("#").strip()
    if "#" in name:  # "[[Page#Section]]" or "Page#Section": the part after the last '#'
        name = name.rsplit("#", 1)[1]
    return name.strip(" []").casefold()


def find_section(markdown: str, name: str) -> Section:
    """The section a heading text or slug names (case-insensitive; '## Endpoints', 'endpoints', 'API#Endpoints')."""
    all_ = sections(markdown)
    key = _key(name)
    if not key:
        raise EditError("section: give a heading's text or slug.")
    by_text = [s for s in all_ if s.text.casefold() == key]
    if len(by_text) == 1:
        return by_text[0]
    by_slug = [s for s in all_ if s.slug == key or s.slug == slugify(key)]
    if len(by_slug) == 1 and not by_text:
        return by_slug[0]
    if by_text or len(by_slug) > 1:
        dup = by_text or by_slug
        slugs = ", ".join(s.slug for s in dup)
        raise EditError(
            f"section '{name}': {len(dup)} headings have that name. Name one by its slug: {slugs}."
        )
    have = ", ".join(f"'{s.text}'" for s in all_) or "none (the page has no headings)"
    raise EditError(
        f"section '{name}' is not on the page. Its headings: {have}. "
        "To add a new section, use mode='after' on an existing one, or mode='append' with no section."
    )


def section_text(markdown: str, name: str) -> str:
    """The Markdown of one section, its heading line included."""
    s = find_section(markdown, name)
    return "\n".join(markdown.split("\n")[s.start : s.end]).strip("\n")


def _block(text: str) -> list[str]:
    return text.strip("\n").split("\n")


def _join(lines: list[str]) -> str:
    out = "\n".join(lines)
    while "\n\n\n" in out:  # keep one blank line between blocks
        out = out.replace("\n\n\n", "\n\n")
    return out.strip("\n") + "\n"


def _splice(lines: list[str], at: int, end: int, new: list[str]) -> list[str]:
    before = lines[:at]
    after = lines[end:]
    if before and before[-1].strip():
        new = [""] + new
    if after and after[0].strip():
        new = new + [""]
    return before + new + after


def edit_section(markdown: str, name: str, new: str, mode: str = "replace") -> str:
    """Change one section.

    Args:
        markdown: The page's Markdown.
        name: Heading text or slug.
        new: Markdown to put in. With mode 'replace', text that starts with a heading of the section's level replaces
            the heading too (a rename); otherwise it replaces the body under the heading, which stays.
        mode: replace | append (end of the section, after its sub-sections) | prepend (just under the heading)
            | before / after (a new block before or after the whole section, e.g. a new section).
    """
    if mode not in MODES:
        raise EditError(f"mode: one of {', '.join(MODES)}.")
    s = find_section(markdown, name)
    lines = markdown.split("\n")
    block = _block(new)
    if mode == "replace":
        head = _HEADING.match(block[0]) if block else None
        if head and len(head.group(1)) == s.level:
            return _join(_splice(lines, s.start, s.end, block))
        body = [""] + block if new.strip() else []
        return _join(_splice(lines, s.start + 1, s.end, body))
    if mode == "prepend":
        return _join(_splice(lines, s.start + 1, s.start + 1, block))
    if mode == "append":
        end = s.end
        while end > s.start + 1 and not lines[end - 1].strip():
            end -= 1
        return _join(_splice(lines, end, end, block))
    if mode == "before":
        return _join(_splice(lines, s.start, s.start, block))
    end = s.end  # after
    while end > s.start + 1 and not lines[end - 1].strip():
        end -= 1
    return _join(_splice(lines, end, end, block))


def edit_passage(markdown: str, find: str, new: str, mode: str = "replace") -> str:
    """Replace the one place where `find` occurs (or put `new` before / after it).

    `find` is exact page Markdown (as docs_read(get) returns it), unique on the page; it may span lines.
    """
    if mode not in ("replace", "before", "after"):
        raise EditError("mode with find: replace, before or after.")
    if not find:
        raise EditError("find: the exact text to change, copied from docs_read(get).")
    count = markdown.count(find)
    if count == 0:
        hint = ""
        if " ".join(find.split()) in " ".join(markdown.split()):
            hint = " It is there with other spaces or line breaks: copy it exactly."
        raise EditError(
            "find: that text is not on the page (it may have been changed since you read it). "
            f"Read the page again with docs_read(get) and copy the text exactly.{hint}"
        )
    if count > 1:
        raise EditError(
            f"find: that text is on the page {count} times. Add a few words around it so it names one place."
        )
    at = markdown.index(find)
    if mode == "replace":
        return markdown[:at] + new + markdown[at + len(find) :]
    if mode == "before":
        return markdown[:at] + new + markdown[at:]
    return markdown[: at + len(find)] + new + markdown[at + len(find) :]


def append_page(markdown: str, new: str) -> str:
    """`new` as the last block of the page."""
    lines = markdown.rstrip("\n").split("\n") if markdown.strip() else []
    return _join(_splice(lines, len(lines), len(lines), _block(new)))


def apply(markdown: str, edit: dict[str, Any], base: str | None = None) -> str:
    """Apply one edit {section | find, markdown, mode} to the page.

    Args:
        markdown: The page as it is now.
        edit: The edit's parameters.
        base: The page as the editor read it (its base_version), when older than now. A section edit goes on only
            when that section reads the same in both; a passage edit is checked by its `find` text.
    """
    new = edit.get("markdown")
    if new is None:
        raise EditError("markdown: the new text.")
    mode = edit.get("mode") or "replace"
    section, find = edit.get("section"), edit.get("find")
    if section and find:
        raise EditError("Give section or find, not both.")
    if find is not None:
        return edit_passage(markdown, find, new, mode)
    if section:
        if base is not None and base != markdown:
            try:
                then = section_text(base, section)
            except EditError:
                then = None
            now = section_text(markdown, section)
            if then != now:
                raise EditError(
                    f"conflict: section '{section}' was changed since the version you read. It now reads:\n\n{now}\n\n"
                    "Apply your change to this text and retry with the page's current version as base_version."
                )
        return edit_section(markdown, section, new, mode)
    if mode != "append":
        raise EditError(
            "Name what to change: section (a heading) or find (exact text); or mode='append' to add to the end."
        )
    return append_page(markdown, new)
